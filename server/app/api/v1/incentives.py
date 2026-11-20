"""Sales targets and incentives over HTTP."""

from __future__ import annotations

import uuid

from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import AdminUser, CurrentUser, DbSession, audit, visible_user_ids
from app.models import SalesIncentive, User
from app.services import eventmail, incentives as svc

router = APIRouter(prefix="/incentives", tags=["incentives"])


class RuleIn(BaseModel):
    is_enabled: bool | None = None
    target_type: str | None = Field(default=None, pattern=r"^(customers|sales)$")
    default_target: int | None = Field(default=None, ge=0, le=1_000_000_000)
    incentive_type: str | None = Field(default=None, pattern=r"^(fixed|percent)$")
    #: Paise for a fixed amount; basis points (0-10000) for a percentage of sales.
    incentive_paise: int | None = Field(default=None, ge=0, le=100_000_000)
    achievement: str | None = Field(default=None, pattern=r"^(full|min|prorata)$")
    min_percent: int | None = Field(default=None, ge=1, le=100)
    requires_approval: bool | None = None


class RuleOut(BaseModel):
    is_enabled: bool
    target_type: str
    default_target: int
    incentive_type: str
    incentive_paise: int
    achievement: str
    min_percent: int
    requires_approval: bool


class TargetRow(BaseModel):
    user_id: uuid.UUID
    name: str
    target: int
    is_set: bool
    achieved: int
    earned: int


class TargetIn(BaseModel):
    user_id: uuid.UUID
    #: None clears the person's own target, so the default applies again.
    target: int | None = Field(default=None, ge=0, le=1_000_000_000)


class TargetsIn(BaseModel):
    year: int = Field(ge=2000, le=2100)
    month: int = Field(ge=1, le=12)
    targets: list[TargetIn] = Field(max_length=2000)


class IncentiveOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    name: str | None = None
    period_year: int
    period_month: int
    target: int
    achieved: int
    amount: int
    status: str
    review_note: str | None = None
    created_at: datetime | None = None


class EvaluateIn(BaseModel):
    year: int = Field(ge=2000, le=2100)
    month: int = Field(ge=1, le=12)


class DecisionIn(BaseModel):
    approve: bool
    note: str | None = Field(default=None, max_length=2000)


def _rule_out(rule) -> RuleOut:
    return RuleOut(is_enabled=rule.is_enabled, target_type=rule.target_type, default_target=rule.default_target,
                   incentive_type=rule.incentive_type, incentive_paise=rule.incentive_paise,
                   achievement=rule.achievement, min_percent=rule.min_percent, requires_approval=rule.requires_approval)


def _target_text(target_type: str, target: int) -> str:
    return f"Rs. {target:,}" if target_type == "sales" else f"{target} customers"


def _people(db, viewer: User) -> list[User]:
    scope = visible_user_ids(db, viewer)
    stmt = select(User).where(User.org_id == viewer.org_id, User.is_active.is_(True))
    if scope is not None:
        stmt = stmt.where(User.id.in_(scope))
    return list(db.scalars(stmt.order_by(User.full_name)))


def _out(db, row: SalesIncentive) -> IncentiveOut:
    person = db.get(User, row.user_id)
    return IncentiveOut(id=row.id, user_id=row.user_id, name=person.full_name if person else None,
                        period_year=row.period_year, period_month=row.period_month, target=row.target,
                        achieved=row.achieved, amount=row.amount, status=row.status, review_note=row.review_note,
                        created_at=row.created_at)


@router.get("/rule", response_model=RuleOut)
def read_rule(viewer: CurrentUser, db: DbSession) -> RuleOut:
    return _rule_out(svc.get_settings(db, viewer.org_id))


@router.put("/rule", response_model=RuleOut)
def write_rule(payload: RuleIn, admin: AdminUser, db: DbSession, request: Request) -> RuleOut:
    row = svc.save_settings(db, admin, payload.model_dump(exclude_none=True))
    audit(db, org_id=admin.org_id, actor=admin, action="incentive.rule_set", request=request,
          target_type="sales_incentive_settings", target_id=str(admin.org_id), detail=payload.model_dump(exclude_none=True))
    db.commit()
    return _rule_out(row)


@router.get("/targets", response_model=list[TargetRow])
def read_targets(admin: AdminUser, db: DbSession, year: int = Query(ge=2000, le=2100), month: int = Query(ge=1, le=12)) -> list[TargetRow]:
    return [TargetRow(**row) for row in svc.targets_for_month(db, admin, year, month, _people(db, admin))]


@router.put("/targets", response_model=list[TargetRow])
def write_targets(payload: TargetsIn, admin: AdminUser, db: DbSession, request: Request, background: BackgroundTasks) -> list[TargetRow]:
    svc.set_targets(db, admin, payload.year, payload.month, [(t.user_id, t.target) for t in payload.targets])
    audit(db, org_id=admin.org_id, actor=admin, action="incentive.targets_set", request=request,
          target_type="sales_targets", target_id=f"{payload.year}-{payload.month:02d}", detail={"count": len(payload.targets)})
    db.commit()
    # Tell each person who was given a target (the notification log makes an unchanged target a no-op).
    rule = svc.get_settings(db, admin.org_id)
    for t in payload.targets:
        if t.target is not None:
            background.add_task(
                eventmail.send_event, "sales_target_assigned", t.user_id,
                dedupe=f"{payload.year}-{payload.month:02d}:{t.target}",
                ctx={"period": f"{payload.month:02d}/{payload.year}", "target": _target_text(rule.target_type, t.target)})
    return [TargetRow(**row) for row in svc.targets_for_month(db, admin, payload.year, payload.month, _people(db, admin))]


@router.post("/evaluate", response_model=list[IncentiveOut])
def evaluate(payload: EvaluateIn, admin: AdminUser, db: DbSession, request: Request, background: BackgroundTasks) -> list[IncentiveOut]:
    """Raise the month's incentives for everyone who has earned one."""
    rows = svc.evaluate(db, admin, payload.year, payload.month, _people(db, admin))
    audit(db, org_id=admin.org_id, actor=admin, action="incentive.evaluated", request=request,
          target_type="sales_incentive", target_id=f"{payload.year}-{payload.month:02d}", detail={"raised": len(rows)})
    db.commit()
    rule = svc.get_settings(db, admin.org_id)
    for row in rows:
        background.add_task(
            eventmail.send_event, "sales_target_completed", row.user_id, dedupe=str(row.id),
            ctx={"period": f"{row.period_month:02d}/{row.period_year}", "target": _target_text(rule.target_type, row.target),
                 "amount": f"Rs. {row.amount / 100:,.0f}"})
    return [_out(db, row) for row in rows]


@router.get("", response_model=list[IncentiveOut])
def list_incentives(viewer: CurrentUser, db: DbSession, status: str | None = None, mine: bool = False) -> list[IncentiveOut]:
    """Incentives the viewer may see: their own, and (for an approver) those they decide."""
    stmt = select(SalesIncentive).where(SalesIncentive.org_id == viewer.org_id)
    if status:
        stmt = stmt.where(SalesIncentive.status == status)
    rows = list(db.scalars(stmt.order_by(SalesIncentive.period_year.desc(), SalesIncentive.period_month.desc())))
    if mine:
        rows = [r for r in rows if r.user_id == viewer.id]
    else:
        rows = [r for r in rows if r.user_id == viewer.id or svc.can_review(db, viewer, r)]
    return [_out(db, row) for row in rows]


@router.post("/{incentive_id}/decision", response_model=IncentiveOut)
def decide(incentive_id: uuid.UUID, payload: DecisionIn, viewer: CurrentUser, db: DbSession, request: Request) -> IncentiveOut:
    row = svc.decide(db, viewer, incentive_id, payload.approve, payload.note, request=request)
    db.commit()
    db.refresh(row)
    return _out(db, row)
