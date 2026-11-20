"""Sales targets and incentives: the rule, the monthly targets, achievement, and approval.

Achievement is read from the CRM: for a "customers" target it is the number of customers the
employee is the account manager of that were added in the month. An incentive is raised only by
an explicit evaluation (HR presses "Raise incentives" for a month), is idempotent, and never
changes one that has already been decided.
"""

from __future__ import annotations

import calendar
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.erp import ErpInvoice, InvoiceKind, InvoiceStatus
from app.models import CrmCustomer, IncentiveStatus, Role, SalesIncentive, SalesIncentiveSettings, SalesTarget, User
from app.services import chains, workflow


class IncentiveError(HTTPException):
    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(status_code, detail={"reason": code, "message": message})


def _now() -> datetime:
    return datetime.now(timezone.utc)


def is_admin(user: User) -> bool:
    return user.role_enum.can_administer


def get_settings(db: Session, org_id: uuid.UUID) -> SalesIncentiveSettings:
    """The rule, or the defaults when nothing has been saved (incentives off)."""
    row = db.get(SalesIncentiveSettings, org_id)
    return row if row is not None else SalesIncentiveSettings(
        org_id=org_id, is_enabled=False, target_type="customers", default_target=0, incentive_type="fixed",
        incentive_paise=0, achievement="full", min_percent=80, requires_approval=True,
    )


def save_settings(db: Session, viewer: User, data: dict) -> SalesIncentiveSettings:
    if not is_admin(viewer):
        raise IncentiveError("not_permitted", "Only an administrator sets the incentive rule.", 403)
    row = db.get(SalesIncentiveSettings, viewer.org_id)
    if row is None:
        row = SalesIncentiveSettings(org_id=viewer.org_id)
        db.add(row)
    merged = {"target_type": row.target_type or "customers", "incentive_type": row.incentive_type or "fixed", **{k: v for k, v in data.items() if v is not None}}
    if merged["incentive_type"] == "percent" and merged["target_type"] != "sales":
        raise IncentiveError("percent_needs_sales", "A percentage of sales needs a sales-amount target.")
    for key, value in data.items():
        if value is not None:
            setattr(row, key, value)
    db.flush()
    return row


def achieved_for(db: Session, org_id: uuid.UUID, user_id: uuid.UUID, year: int, month: int, target_type: str) -> int:
    """What the employee has achieved in the month, by the rule's own measure."""
    start = datetime(year, month, 1, tzinfo=timezone.utc)
    end = datetime(year + (month == 12), (month % 12) + 1, 1, tzinfo=timezone.utc)
    if target_type == "customers":
        return int(db.scalar(
            select(func.count(CrmCustomer.id)).where(
                CrmCustomer.org_id == org_id, CrmCustomer.manager_id == user_id,
                CrmCustomer.created_at >= start, CrmCustomer.created_at < end,
            )
        ) or 0)
    # Sales: rupees invoiced before GST in the month (posted invoices the person sold, less their credit notes).
    seller = func.coalesce(ErpInvoice.salesperson_id, ErpInvoice.created_by)
    rows = db.execute(
        select(ErpInvoice.kind, func.coalesce(func.sum(ErpInvoice.sub_total), 0)).where(
            ErpInvoice.org_id == org_id, seller == user_id, ErpInvoice.status == InvoiceStatus.POSTED.value,
            ErpInvoice.kind != InvoiceKind.PROFORMA.value,
            ErpInvoice.invoice_date >= start.date(), ErpInvoice.invoice_date < end.date(),
        ).group_by(ErpInvoice.kind)
    ).all()
    total = sum((-v if k == InvoiceKind.CREDIT_NOTE.value else v) for k, v in rows)
    return max(0, int(total))


def amount_for(rule: SalesIncentiveSettings, target: int, achieved: int) -> int:
    """The incentive earned, in paise. Nothing when there is no target or nothing achieved."""
    if target <= 0 or achieved <= 0:
        return 0
    if rule.achievement == "full":
        met = achieved >= target
    elif rule.achievement == "min":
        met = achieved * 100 >= target * rule.min_percent
    else:
        met = True
    if rule.incentive_type == "percent":
        # A share of the sales actually made (rupees -> paise), once the condition is met.
        return int(achieved * rule.incentive_paise / 100) if met else 0
    if rule.achievement == "prorata":
        return int(rule.incentive_paise * min(achieved, target) / target)
    return rule.incentive_paise if met else 0


def targets_for_month(db: Session, viewer: User, year: int, month: int, people: list[User]) -> list[dict]:
    rule = get_settings(db, viewer.org_id)
    explicit = {
        t.user_id: t.target for t in db.scalars(
            select(SalesTarget).where(SalesTarget.org_id == viewer.org_id, SalesTarget.period_year == year,
                                      SalesTarget.period_month == month))
    }
    out = []
    for person in people:
        target = explicit.get(person.id, rule.default_target)
        achieved = achieved_for(db, viewer.org_id, person.id, year, month, rule.target_type)
        out.append({
            "user_id": person.id, "name": person.full_name, "target": target, "is_set": person.id in explicit,
            "achieved": achieved, "earned": amount_for(rule, target, achieved),
        })
    return out


def set_targets(db: Session, viewer: User, year: int, month: int, rows: list[tuple[uuid.UUID, int | None]]) -> None:
    """Set (or clear, with None) each person's target for the month."""
    if not is_admin(viewer):
        raise IncentiveError("not_permitted", "Only an administrator assigns targets.", 403)
    for user_id, target in rows:
        person = db.get(User, user_id)
        if person is None or person.org_id != viewer.org_id:
            raise IncentiveError("not_found", "No such colleague.", 404)
        existing = db.scalar(select(SalesTarget).where(
            SalesTarget.org_id == viewer.org_id, SalesTarget.user_id == user_id,
            SalesTarget.period_year == year, SalesTarget.period_month == month))
        if target is None:
            if existing is not None:
                db.delete(existing)
            continue
        if existing is None:
            db.add(SalesTarget(org_id=viewer.org_id, user_id=user_id, period_year=year, period_month=month, target=target))
        else:
            existing.target = target
    db.flush()


def evaluate(db: Session, viewer: User, year: int, month: int, people: list[User]) -> list[SalesIncentive]:
    """Raise the month's incentives. Idempotent: a person already raised for the month is left
    alone if it has been decided, and re-priced if it is still pending."""
    if not is_admin(viewer):
        raise IncentiveError("not_permitted", "Only an administrator raises incentives.", 403)
    rule = get_settings(db, viewer.org_id)
    if not rule.is_enabled:
        raise IncentiveError("incentives_off", "Sales targets and incentives are switched off.", 409)
    raised: list[SalesIncentive] = []
    for row in targets_for_month(db, viewer, year, month, people):
        if row["earned"] <= 0:
            continue
        existing = db.scalar(select(SalesIncentive).where(
            SalesIncentive.org_id == viewer.org_id, SalesIncentive.user_id == row["user_id"],
            SalesIncentive.period_year == year, SalesIncentive.period_month == month))
        if existing is not None:
            if existing.status == IncentiveStatus.PENDING.value:
                existing.target, existing.achieved, existing.amount = row["target"], row["achieved"], row["earned"]
            raised.append(existing)
            continue
        incentive = SalesIncentive(
            org_id=viewer.org_id, user_id=row["user_id"], period_year=year, period_month=month,
            target=row["target"], achieved=row["achieved"], amount=row["earned"],
            status=IncentiveStatus.PENDING.value if rule.requires_approval else IncentiveStatus.APPROVED.value,
        )
        if not rule.requires_approval:
            incentive.reviewed_at = _now()
            incentive.review_note = "Approved automatically: approval is switched off"
        db.add(incentive)
        db.flush()
        if rule.requires_approval:
            person = db.get(User, row["user_id"])
            chains.start_for(db, kind="sales_incentive", record_id=incentive.id, subject=person, record=incentive)
        raised.append(incentive)
    db.flush()
    return raised


def can_review(db: Session, viewer: User, incentive: SalesIncentive) -> bool:
    """An administrator, the person's reporting manager, or whoever the chain is waiting on."""
    if is_admin(viewer) or viewer.role_enum is Role.OWNER:
        return True
    person = db.get(User, incentive.user_id)
    if person is not None and person.manager_id == viewer.id:
        return True
    return chains.is_current_reviewer(db, incentive.id, viewer)


def decide(db: Session, viewer: User, incentive_id: uuid.UUID, approve: bool, note: str | None,
           request: Request | None = None) -> SalesIncentive:
    incentive = db.get(SalesIncentive, incentive_id)
    if incentive is None or incentive.org_id != viewer.org_id:
        raise IncentiveError("not_found", "Incentive not found.", 404)
    if not can_review(db, viewer, incentive):
        raise IncentiveError("not_permitted", "You do not approve this person's incentive.", 403)
    workflow.decide(
        db, policy=workflow.INCENTIVE, record=incentive, reviewer=viewer, approve=approve,
        note=note, request=request,
        detail={"amount": incentive.amount, "period": f"{incentive.period_year}-{incentive.period_month:02d}"},
    )
    db.flush()
    return incentive


def label_for(year: int, month: int) -> str:
    return f"{calendar.month_name[month]} {year}"
