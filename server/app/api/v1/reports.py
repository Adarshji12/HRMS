"""Reports: one endpoint per shape, thirteen report definitions behind it."""

from __future__ import annotations

import csv
import io
import uuid
from datetime import date, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from app.api.deps import deny_page, CurrentUser, DbSession, visible_user_ids
from app.models import User
from app.services import report_builder as rb
from app.services import reports as agg

router = APIRouter(prefix="/reports", tags=["reports"])

MAX_DAYS = 366


def _filters(
    db,
    viewer: User,
    start: date | None,
    end: date | None,
    user_id: uuid.UUID | None,
    team_id: uuid.UUID | None,
    department_id: uuid.UUID | None,
) -> rb.Filters:
    tz_name = rb.org_timezone(db, viewer.org_id)
    end = end or datetime.now(agg.tz_for(tz_name)).date()
    start = start or end - timedelta(days=29)
    if end < start:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "end is before start")
    if (end - start).days + 1 > MAX_DAYS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, f"Range exceeds {MAX_DAYS} days"
        )

    scope = visible_user_ids(db, viewer)

    # Every narrowing filter intersects with the viewer's permitted scope — it
    # can never widen it. A manager filtering by another team still sees only
    # their own people.
    narrowing = []
    if user_id:
        narrowing.append({user_id})
    if team_id or department_id:
        stmt = select(User.id).where(User.org_id == viewer.org_id)
        if team_id:
            stmt = stmt.where(User.team_id == team_id)
        if department_id:
            stmt = stmt.where(User.department_id == department_id)
        narrowing.append(set(db.scalars(stmt).all()))

    for subset in narrowing:
        scope = sorted(subset if scope is None else subset & set(scope), key=str)

    return rb.Filters(
        org_id=viewer.org_id, start=start, end=end, tz_name=tz_name, scope=scope
    )


@router.get("/catalogue")
def catalogue(viewer: CurrentUser) -> list[dict]:
    deny_page(viewer, "reports")
    return rb.CATALOGUE


@router.get("/{key}")
def run_report(
    key: str,
    viewer: CurrentUser,
    db: DbSession,
    start: date | None = None,
    end: date | None = None,
    user_id: uuid.UUID | None = None,
    team_id: uuid.UUID | None = None,
    department_id: uuid.UUID | None = None,
) -> dict:
    deny_page(viewer, "reports")
    f = _filters(db, viewer, start, end, user_id, team_id, department_id)
    try:
        report = rb.build(db, key, f)
    except KeyError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown report: {key}") from None
    return {
        **report.as_dict(),
        "start": f.start.isoformat(),
        "end": f.end.isoformat(),
        "timezone": f.tz_name,
    }


@router.get("/{key}/export.csv")
def export_report(
    key: str,
    viewer: CurrentUser,
    db: DbSession,
    start: date | None = None,
    end: date | None = None,
    user_id: uuid.UUID | None = None,
    team_id: uuid.UUID | None = None,
    department_id: uuid.UUID | None = None,
) -> StreamingResponse:
    deny_page(viewer, "reports")
    f = _filters(db, viewer, start, end, user_id, team_id, department_id)
    try:
        report = rb.build(db, key, f)
    except KeyError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown report: {key}") from None

    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow([c.label for c in report.columns])

    for row in report.rows:
        line = []
        for column in report.columns:
            value = row.get(column.key)
            if value is None:
                line.append("")
            elif column.type == "duration":
                # Decimal hours, not "7h 30m": a spreadsheet cannot sum the
                # latter, and summing is the whole point of exporting.
                line.append(round(value / 3600, 2))
            elif column.type == "money":
                line.append(round(value / 100, 2))
            elif column.type == "time":
                line.append(str(value).replace("T", " ")[:19])
            else:
                line.append(value)
        writer.writerow(line)

    buf.seek(0)
    filename = f"{key}-report-{f.start.isoformat()}-to-{f.end.isoformat()}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
