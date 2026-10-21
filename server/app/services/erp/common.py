"""What every ERP service shares: the permission rule, numbering, money and tax.

The permission rule
-------------------

:func:`may` is the one question every ERP write asks, and it is deliberately
not ``User.has`` on its own. The HRMS flags restrict *after* a role check —
an employee with ``can_manage_assets`` left at its default True still cannot
manage assets, because the asset service first asks whether they administer
anything. The ERP has no such second check of its own, so :func:`may` folds it
in:

1. **The owner may always.** The same rule payroll uses: a workspace must not be
   able to lock itself out of its own books by editing a role.
2. **A named role decides for its holders.** That is what roles are for — a
   "Storekeeper" role carries ``can_manage_inventory`` and nothing else.
3. **Without a named role, only an administrator may**, and then subject to
   their own column. A plain employee or manager with no role reaches nothing
   here, whatever their columns say.

Raising a requisition is the one write that asks nothing: the PRD makes every
employee a potential requester (§6.6.5), and approval is where the gate is.
"""

from __future__ import annotations

import uuid
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Iterable

from fastapi import HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import audit
from app.models import Organization, Role, User
from app.models.erp import ErpCounter, ErpSettings

CENT = Decimal("0.01")
MILLI = Decimal("0.001")
ZERO = Decimal("0")


class ErpError(HTTPException):
    """``{"reason", "message"}``, the house refusal shape."""

    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(status_code, detail={"reason": code, "message": message})
        self.code = code


def not_found(what: str) -> ErpError:
    return ErpError("not_found", f"No such {what}.", status.HTTP_404_NOT_FOUND)


# --------------------------------------------------------------------------- #
# Permission
# --------------------------------------------------------------------------- #

#: What each capability lets somebody do, for the refusal sentence.
CAPABILITY_TEXT: dict[str, str] = {
    "can_manage_erp_masters": "maintain items, vendors and warehouses",
    "can_verify_vendors": "approve vendors and verify their bank details",
    "can_manage_procurement": "raise RFQs and purchase orders",
    "can_approve_purchases": "approve requisitions and purchase orders",
    "can_manage_inventory": "receive, issue and move stock",
    "can_approve_stock": "approve stock adjustments",
    "can_manage_sales_orders": "book sales orders and dispatch them",
    "can_approve_sales_orders": "release sales orders",
    "can_manage_billing": "raise invoices and record receipts",
    "can_approve_billing": "approve credit notes",
}


def may(user: User, flag: str) -> bool:
    """See the module docstring — owner, then named role, then administrators."""
    if user.role_enum is Role.OWNER:
        return True
    if user.org_role is None and not user.role_enum.can_administer:
        return False
    return user.has(flag)


def require(user: User, flag: str) -> None:
    if not may(user, flag):
        raise ErpError(
            "permission_denied",
            f"Your account is not permitted to {CAPABILITY_TEXT.get(flag, flag)}.",
            status.HTTP_403_FORBIDDEN,
        )


def capabilities(user: User) -> dict[str, bool]:
    """Every ERP capability for this person — what the console shows or hides."""
    return {flag: may(user, flag) for flag in CAPABILITY_TEXT}


def kernel_decide(
    db: Session, viewer: User, policy: Any, record: Any, payload: Any, *,
    on_approve: Any = None, on_reject: Any = None, request: Request | None = None,
) -> Any:
    """One decision on an ERP document, through the workflow kernel.

    Who may decide is answered in exactly one of two ways, never both:

    * **A chain is configured** for this flow (Settings → Workflow): the chain
      decides, rung by rung, through ``chains.advance`` — which is also what lets
      a reporting manager approve a requisition without holding the capability.
    * **No chain**: the flow's capability, held by somebody other than the
      requester. This is the single-step approval most companies start with.

    The kernel then refuses a second decision, refuses self-approval, requires a
    reason on a rejection and writes the audit row — the same four guarantees
    every HRMS approval already has.
    """
    from app.services import chains, workflow

    if not chains.steps_for(db, record.id):
        require(viewer, policy.capability)
    return workflow.decide(
        db, policy=policy, record=record, reviewer=viewer, approve=payload.approve,
        note=payload.note, request=request, on_approve=on_approve, on_reject=on_reject,
    )


def record_audit(
    db: Session, viewer: User, action: str, row: Any, *,
    request: Request | None = None, detail: dict | None = None,
) -> None:
    audit(
        db, org_id=viewer.org_id, actor=viewer, action=f"erp.{action}", request=request,
        target_type=getattr(row, "__tablename__", None), target_id=str(row.id),
        detail={**({"number": row.number} if getattr(row, "number", None) else {}), **(detail or {})},
    )


def require_reason(reason: str | None, what: str) -> str:
    """Every rejection, cancellation, reversal and override carries a reason (§6.x.6)."""
    cleaned = (reason or "").strip()
    if not cleaned:
        raise ErpError("reason_required", f"Say why the {what} — it is kept on the record.")
    return cleaned


# --------------------------------------------------------------------------- #
# Money and quantity
# --------------------------------------------------------------------------- #


def money(value: Any) -> Decimal:
    return Decimal(str(value or 0)).quantize(CENT, rounding=ROUND_HALF_UP)


def qty(value: Any) -> Decimal:
    return Decimal(str(value or 0)).quantize(MILLI, rounding=ROUND_HALF_UP)


def price_line(quantity: Any, rate: Any, gst_percent: Any) -> dict[str, Decimal]:
    """One line's arithmetic. Rounded per line, as a printed document shows it."""
    q = qty(quantity)
    taxable = money(q * money(rate))
    tax = money(taxable * Decimal(str(gst_percent or 0)) / Decimal("100"))
    return {"quantity": q, "rate": money(rate), "taxable_value": taxable,
            "tax_amount": tax, "amount": money(taxable + tax)}


def split_tax(tax_total: Decimal, *, interstate: bool) -> dict[str, Decimal]:
    """CGST+SGST or IGST — the second half takes the remainder, as in CRM."""
    if interstate:
        return {"cgst": ZERO, "sgst": ZERO, "igst": money(tax_total)}
    half = money(tax_total / 2)
    return {"cgst": half, "sgst": money(tax_total - half), "igst": ZERO}


def company_state(db: Session, org_id: uuid.UUID) -> str | None:
    org = db.get(Organization, org_id)
    return ((org.state or "").strip().lower() or None) if org else None


def is_interstate(db: Session, org_id: uuid.UUID, place: str | None) -> bool:
    """Unknown place of supply is intra-state — the CRM's rule, kept identical
    so a quotation and the order converted from it never disagree on tax."""
    home = company_state(db, org_id)
    other = (place or "").strip().lower() or None
    return bool(home and other and home != other)


# --------------------------------------------------------------------------- #
# Numbering
# --------------------------------------------------------------------------- #


def fiscal_year(on: date) -> str:
    """India's April–March year, as ``26-27``."""
    start = on.year if on.month >= 4 else on.year - 1
    return f"{start % 100:02d}-{(start + 1) % 100:02d}"


def next_number(db: Session, org_id: uuid.UUID, prefix: str, on: date) -> str:
    """``PO/26-27/0001``. Resets each fiscal year, which is what a GST series does.

    No lock, as in ``services.crm.next_number``: every document table carries a
    unique constraint on its number, so a concurrent collision fails the second
    insert instead of issuing a duplicate.
    """
    period = fiscal_year(on)
    row = db.scalar(select(ErpCounter).where(
        ErpCounter.org_id == org_id, ErpCounter.series == prefix, ErpCounter.period == period,
    ))
    if row is None:
        row = ErpCounter(org_id=org_id, series=prefix, period=period, last_number=0)
        db.add(row)
    row.last_number += 1
    db.flush()
    return f"{prefix}/{period}/{row.last_number:04d}"


# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #


def get_settings(db: Session, org_id: uuid.UUID) -> ErpSettings:
    row = db.scalar(select(ErpSettings).where(ErpSettings.org_id == org_id))
    if row is None:
        row = ErpSettings(org_id=org_id)
        db.add(row)
        db.flush()
    return row


# --------------------------------------------------------------------------- #
# Lookups
# --------------------------------------------------------------------------- #


def get_owned(db: Session, model: type, org_id: uuid.UUID, row_id: uuid.UUID, what: str) -> Any:
    """One row of this organisation, or 404 — never another tenant's row."""
    row = db.get(model, row_id)
    if row is None or row.org_id != org_id:
        raise not_found(what)
    return row


def user_names(db: Session, org_id: uuid.UUID, ids: Iterable[uuid.UUID | None]) -> dict[uuid.UUID, str]:
    wanted = {i for i in ids if i}
    if not wanted:
        return {}
    return {
        row.id: row.full_name or row.email
        for row in db.scalars(select(User).where(User.org_id == org_id, User.id.in_(wanted)))
    }


def plain(value: Any) -> Any:
    """JSON-safe without turning money into a float.

    FastAPI's encoder renders ``Decimal`` as a float, which is how ₹0.10 + ₹0.20
    becomes 0.30000000000000004 in somebody's browser. Strings, as the CRM sends.
    """
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    return value


def row_dict(row: Any, *, exclude: tuple[str, ...] = ()) -> dict:
    """Every column of a row, JSON-safe."""
    return {
        column.name: plain(getattr(row, column.name))
        for column in row.__table__.columns
        if column.name not in exclude and column.name != "org_id"
    }
