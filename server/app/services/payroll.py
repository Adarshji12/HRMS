"""Payroll checkpoint 1: the salary structure resolver and its rules.

The four that matter:

**Components resolve to sum to gross, exactly.** ``resolve`` computes each
component in dependency order and gives the remainder to the ``BALANCE``
component. If a company's percentages already exceed gross, that is an error the
person defining the structure must see — not a negative special allowance quietly
absorbing it.

**A revision is a new row.** ``set_structure`` closes the previous one the day
before the new one starts, so no date falls in a gap and none is covered twice.
Payroll has to be able to reproduce a pay run from eighteen months ago, which is
impossible if the structure it ran against was edited in place.

**The catalogue is snapshotted onto the structure.** A component defined as "40%
of basic" has its rupee figure *and its rule* copied at creation. Editing the
catalogue afterwards changes what the next structure says and nothing about the
last one — the same rule letters and timesheets already follow.

**Salary visibility is the narrowest permission in the product.** An
administrator needs ``can_manage_payroll`` explicitly; the owner always has it,
so a workspace can never lock itself out of its own payroll. An employee sees
their own structure through a path that consults no flag at all, because a person
is entitled to know what they are paid.
"""

from __future__ import annotations

import logging
import uuid
from datetime import date, timedelta

from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import audit
from app.models import (
    Calculation,
    ComponentKind,
    PayComponent,
    Role,
    SalaryStructure,
    SalaryStructureComponent,
    User,
)

log = logging.getLogger(__name__)


class PayrollError(Exception):
    """A rule said no, with a code the console can branch on."""

    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


# --------------------------------------------------------------------------- #
# Permissions
# --------------------------------------------------------------------------- #


def can_manage(viewer: User) -> bool:
    """May see and set other people's salaries.

    The owner always may, regardless of the flag. That is what stops the
    flag's ``False`` default — chosen so applying the migration does not hand
    every administrator every salary — from locking a workspace out of its own
    payroll with nobody able to grant it back.
    """
    if viewer.role == Role.OWNER.value:
        return True
    return viewer.role == Role.ADMIN.value and viewer.can_manage_payroll


def _require_manager(viewer: User) -> None:
    if not can_manage(viewer):
        raise PayrollError("not_permitted", "You may not manage payroll.", 403)


# --------------------------------------------------------------------------- #
# Components
# --------------------------------------------------------------------------- #


def get_component(db: Session, org_id: uuid.UUID, component_id: uuid.UUID) -> PayComponent:
    row = db.get(PayComponent, component_id)
    if row is None or row.org_id != org_id:
        raise PayrollError("component_not_found", "Pay component not found", 404)
    return row


def list_components(
    db: Session, org_id: uuid.UUID, *, active_only: bool = False
) -> list[PayComponent]:
    statement = select(PayComponent).where(PayComponent.org_id == org_id)
    if active_only:
        statement = statement.where(PayComponent.is_active.is_(True))
    return list(
        db.scalars(statement.order_by(PayComponent.sort_order, PayComponent.code))
    )


def basic_component(db: Session, org_id: uuid.UUID) -> PayComponent | None:
    return db.scalar(
        select(PayComponent).where(
            PayComponent.org_id == org_id,
            PayComponent.is_basic.is_(True),
            PayComponent.is_active.is_(True),
        )
    )


def _check_component_shape(db: Session, org_id: uuid.UUID, payload, existing_id=None) -> None:
    """Rules a component must satisfy on its own and against its siblings."""
    calculation = Calculation(payload.calculation)

    if calculation in (Calculation.PERCENT_OF_BASIC, Calculation.PERCENT_OF_GROSS):
        if payload.rate_bps <= 0:
            raise PayrollError(
                "rate_required",
                "A percentage component needs a rate above zero.",
            )
    if calculation is Calculation.BALANCE:
        if payload.kind != ComponentKind.EARNING.value:
            raise PayrollError(
                "balance_must_earn",
                "Only an earning can absorb the balance of gross.",
            )
        other = db.scalar(
            select(PayComponent).where(
                PayComponent.org_id == org_id,
                PayComponent.calculation == Calculation.BALANCE.value,
                PayComponent.is_active.is_(True),
                PayComponent.id != (existing_id or uuid.uuid4()),
            )
        )
        if other is not None:
            # Two components each wanting the same remainder is not a
            # configuration, it is a coin toss.
            raise PayrollError(
                "balance_exists",
                f"{other.name} already absorbs the balance. A structure can only "
                "have one such component.",
                409,
            )

    if payload.is_basic:
        if calculation is Calculation.PERCENT_OF_BASIC:
            # It would be a percentage of itself.
            raise PayrollError(
                "basic_self_reference",
                "The basic component cannot be a percentage of basic.",
            )
        other = db.scalar(
            select(PayComponent).where(
                PayComponent.org_id == org_id,
                PayComponent.is_basic.is_(True),
                PayComponent.id != (existing_id or uuid.uuid4()),
            )
        )
        if other is not None:
            raise PayrollError(
                "basic_exists",
                f"{other.name} is already the basic component.",
                409,
            )


def create_component(
    db: Session, viewer: User, payload, *, request: Request | None = None
) -> PayComponent:
    _require_manager(viewer)
    code = payload.code.strip().upper()
    if db.scalar(
        select(PayComponent).where(
            PayComponent.org_id == viewer.org_id, PayComponent.code == code
        )
    ):
        raise PayrollError(
            "duplicate_code",
            f"A component with code {code} already exists.",
            409,
        )
    _check_component_shape(db, viewer.org_id, payload)

    row = PayComponent(
        org_id=viewer.org_id,
        code=code,
        name=payload.name.strip(),
        kind=payload.kind,
        calculation=payload.calculation,
        rate_bps=payload.rate_bps,
        is_basic=payload.is_basic,
        is_pf_wage=payload.is_pf_wage,
        is_esi_wage=payload.is_esi_wage,
        is_taxable=payload.is_taxable,
        sort_order=payload.sort_order,
        is_active=payload.is_active,
        description=(payload.description or "").strip() or None,
    )
    db.add(row)
    audit(db, org_id=viewer.org_id, actor=viewer, action="payroll.component_created",
          request=request, target_type="pay_component", target_id=str(row.id),
          detail={"code": row.code, "calculation": row.calculation,
                  "rate_bps": row.rate_bps, "is_basic": row.is_basic})
    db.commit()
    db.refresh(row)
    return row


def update_component(
    db: Session,
    viewer: User,
    component_id: uuid.UUID,
    payload,
    *,
    request: Request | None = None,
) -> PayComponent:
    """Edit the catalogue.

    Changes what the *next* structure says and nothing about existing ones,
    because every structure carries its own snapshot. That is not a limitation
    to work around — it is what makes a payslip from last year still explain
    itself.
    """
    _require_manager(viewer)
    row = get_component(db, viewer.org_id, component_id)
    changes = payload.model_dump(exclude_unset=True)

    merged = type("Merged", (), {
        "calculation": changes.get("calculation", row.calculation),
        "rate_bps": changes.get("rate_bps", row.rate_bps),
        "kind": changes.get("kind", row.kind),
        "is_basic": changes.get("is_basic", row.is_basic),
    })()
    _check_component_shape(db, viewer.org_id, merged, existing_id=row.id)

    touched = []
    for field, value in changes.items():
        if field == "code" and value:
            value = value.strip().upper()
        elif isinstance(value, str):
            value = value.strip() or None
        if getattr(row, field, None) != value:
            setattr(row, field, value)
            touched.append(field)

    if touched:
        audit(db, org_id=viewer.org_id, actor=viewer, action="payroll.component_updated",
              request=request, target_type="pay_component", target_id=str(row.id),
              detail={"code": row.code, "fields": sorted(touched)})
        db.commit()
        db.refresh(row)
    return row


# --------------------------------------------------------------------------- #
# The resolver
# --------------------------------------------------------------------------- #


def _bps_of(amount: int, bps: int) -> int:
    """``bps`` basis points of ``amount``, rounded half-up, in paise.

    Integer arithmetic with one rounding step. Rounding each component
    independently is fine precisely because the BALANCE component absorbs
    whatever the rounding leaves over — which is why a structure without one
    must state amounts that already add up.
    """
    return (amount * bps + 5_000) // 10_000


def resolve(
    components: list[PayComponent],
    *,
    gross_monthly: int,
    fixed_amounts: dict[uuid.UUID, int],
) -> list[tuple[PayComponent, int]]:
    """Work out each earning component's monthly figure.

    Order is a dependency order, not a preference:

    1. ``FIXED`` — stated per employee.
    2. ``PERCENT_OF_GROSS`` — gross is an input, so these need nothing else.
    3. ``PERCENT_OF_BASIC`` — needs basic, which resolved in 1 or 2.
    4. ``BALANCE`` — needs everything else.

    Deduction components are ignored here. The deductions that matter (PF, ESI,
    TDS) are computed from statutory rules at pay time, not stated on a
    structure, and a structure listing a made-up deduction figure would be a
    number nobody could reconcile.
    """
    earnings = [c for c in components if c.kind == ComponentKind.EARNING.value]
    resolved: dict[uuid.UUID, int] = {}

    for component in earnings:
        if component.calculation == Calculation.FIXED.value:
            amount = fixed_amounts.get(component.id)
            if amount is None:
                raise PayrollError(
                    "amount_required",
                    f"{component.name} is a fixed component and needs an amount.",
                )
            if amount < 0:
                raise PayrollError("negative_amount", f"{component.name} cannot be negative.")
            resolved[component.id] = amount

    for component in earnings:
        if component.calculation == Calculation.PERCENT_OF_GROSS.value:
            resolved[component.id] = _bps_of(gross_monthly, component.rate_bps)

    basic = next((c for c in earnings if c.is_basic), None)
    for component in earnings:
        if component.calculation == Calculation.PERCENT_OF_BASIC.value:
            if basic is None or basic.id not in resolved:
                raise PayrollError(
                    "no_basic",
                    f"{component.name} is a percentage of basic, but no basic "
                    "component is defined.",
                )
            resolved[component.id] = _bps_of(resolved[basic.id], component.rate_bps)

    balance = [c for c in earnings if c.calculation == Calculation.BALANCE.value]
    if len(balance) > 1:  # pragma: no cover - the catalogue rule prevents this
        raise PayrollError("balance_exists", "Only one component may absorb the balance.")

    assigned = sum(resolved.values())
    if balance:
        remainder = gross_monthly - assigned
        if remainder < 0:
            # Surfaced rather than clamped: a negative special allowance is not a
            # salary, and silently zeroing it would hide that the percentages are
            # wrong until somebody compared a payslip with an offer letter.
            raise PayrollError(
                "over_gross",
                f"The components come to more than gross by "
                f"{-remainder / 100:,.2f}. Lower a percentage or raise gross.",
            )
        resolved[balance[0].id] = remainder
    elif assigned != gross_monthly:
        raise PayrollError(
            "does_not_balance",
            f"The components come to {assigned / 100:,.2f} but gross is "
            f"{gross_monthly / 100:,.2f}. Add a component that absorbs the "
            "balance, or adjust the amounts.",
        )

    ordered = sorted(earnings, key=lambda c: (c.sort_order, c.code))
    return [(component, resolved[component.id]) for component in ordered]


# --------------------------------------------------------------------------- #
# Structures
# --------------------------------------------------------------------------- #


def structures_for(db: Session, org_id: uuid.UUID, user_id: uuid.UUID) -> list[SalaryStructure]:
    """Every revision, newest first."""
    return list(
        db.scalars(
            select(SalaryStructure)
            .where(SalaryStructure.org_id == org_id, SalaryStructure.user_id == user_id)
            .order_by(SalaryStructure.effective_from.desc())
        )
    )


def structure_on(
    db: Session, org_id: uuid.UUID, user_id: uuid.UUID, on: date
) -> SalaryStructure | None:
    """The structure in force on a given day.

    The query a pay run will make. Written now, like the loan deduction
    schedule, so the model is proven against its real consumer.
    """
    return db.scalar(
        select(SalaryStructure)
        .where(
            SalaryStructure.org_id == org_id,
            SalaryStructure.user_id == user_id,
            SalaryStructure.effective_from <= on,
        )
        .order_by(SalaryStructure.effective_from.desc())
        .limit(1)
    )


def current_structure(
    db: Session, org_id: uuid.UUID, user_id: uuid.UUID
) -> SalaryStructure | None:
    return structure_on(db, org_id, user_id, date.today())


def set_structure(
    db: Session,
    viewer: User,
    user_id: uuid.UUID,
    payload,
    *,
    request: Request | None = None,
) -> SalaryStructure:
    """Record a new salary, effective from a date.

    Never an edit. The previous structure is closed the day before this one
    starts, so the two neither overlap nor leave a gap — which matters because a
    pay run asks "what was in force on the 1st" and both answers are wrong if
    the timeline has holes.
    """
    _require_manager(viewer)
    subject = db.get(User, user_id)
    if subject is None or subject.org_id != viewer.org_id:
        raise PayrollError("employee_not_found", "Employee not found", 404)

    catalogue = list_components(db, viewer.org_id, active_only=True)
    if not catalogue:
        raise PayrollError(
            "no_components",
            "Define the pay components first — a structure is made of them.",
        )

    chosen_ids = {line.component_id for line in payload.components}
    unknown = chosen_ids - {c.id for c in catalogue}
    if unknown:
        raise PayrollError("component_not_found", "Unknown pay component.", 404)
    chosen = [c for c in catalogue if c.id in chosen_ids]
    fixed_amounts = {
        line.component_id: line.amount
        for line in payload.components
        if line.amount is not None
    }

    lines = resolve(chosen, gross_monthly=payload.gross_monthly,
                    fixed_amounts=fixed_amounts)

    existing = db.scalar(
        select(SalaryStructure).where(
            SalaryStructure.user_id == subject.id,
            SalaryStructure.effective_from == payload.effective_from,
        )
    )
    if existing is not None:
        raise PayrollError(
            "duplicate_effective_date",
            "A structure already starts on that date. Choose another date, or "
            "delete that revision first.",
            409,
        )

    structure = SalaryStructure(
        org_id=viewer.org_id,
        user_id=subject.id,
        effective_from=payload.effective_from,
        gross_monthly=payload.gross_monthly,
        reason=(payload.reason or "").strip() or None,
        created_by=viewer.id,
    )
    db.add(structure)
    db.flush()

    for component, amount in lines:
        db.add(
            SalaryStructureComponent(
                org_id=viewer.org_id,
                structure_id=structure.id,
                component_id=component.id,
                amount=amount,
                # Snapshot, so this row keeps explaining itself after the
                # catalogue changes.
                code=component.code,
                name=component.name,
                kind=component.kind,
                calculation=component.calculation,
                rate_bps=component.rate_bps,
                is_pf_wage=component.is_pf_wage,
                is_esi_wage=component.is_esi_wage,
                is_taxable=component.is_taxable,
                sort_order=component.sort_order,
            )
        )

    _reclose(db, subject.id)

    audit(db, org_id=viewer.org_id, actor=viewer, action="payroll.structure_set",
          request=request, target_type="salary_structure", target_id=str(structure.id),
          detail={"for": str(subject.id), "gross_monthly": structure.gross_monthly,
                  "effective_from": payload.effective_from.isoformat(),
                  "components": len(lines), "reason": structure.reason})
    db.commit()
    db.refresh(structure)
    return structure


def _reclose(db: Session, user_id: uuid.UUID) -> None:
    """Rewrite every ``effective_to`` from the ordered list of start dates.

    Recomputed wholesale rather than patched at the edges. A revision can be
    inserted *between* two existing ones — backdating a correction is routine —
    and patching only the immediately previous row leaves the one after it
    claiming a period it no longer covers.
    """
    rows = list(
        db.scalars(
            select(SalaryStructure)
            .where(SalaryStructure.user_id == user_id)
            .order_by(SalaryStructure.effective_from)
        )
    )
    for index, row in enumerate(rows):
        following = rows[index + 1] if index + 1 < len(rows) else None
        row.effective_to = (
            following.effective_from - timedelta(days=1) if following else None
        )
    db.flush()


def delete_structure(
    db: Session, viewer: User, structure_id: uuid.UUID, *, request: Request | None = None
) -> None:
    """Remove a revision, unless a payslip was built from it.

    The guard checkpoint 1 promised and checkpoint 2 made necessary. A payslip
    keeps its own frozen lines, so deleting the structure does not corrupt what
    was paid — but the payslip could no longer say which revision produced it,
    and "why was I paid this" is exactly the question that pointer answers.

    Refused rather than silently detached: `payslips.structure_id` is SET NULL,
    so the delete would succeed and the loss would only show up months later.
    """
    _require_manager(viewer)
    row = db.get(SalaryStructure, structure_id)
    if row is None or row.org_id != viewer.org_id:
        raise PayrollError("not_found", "Salary structure not found", 404)

    from app.models import Payslip

    used_by = db.scalar(
        select(func.count(Payslip.id)).where(Payslip.structure_id == row.id)
    ) or 0
    if used_by:
        raise PayrollError(
            "structure_in_use",
            f"{used_by} payslip(s) were computed from this revision. Supersede it "
            "with a new one instead of deleting it.",
            409,
        )

    user_id, effective_from = row.user_id, row.effective_from
    db.delete(row)
    db.flush()
    _reclose(db, user_id)
    audit(db, org_id=viewer.org_id, actor=viewer, action="payroll.structure_deleted",
          request=request, target_type="salary_structure", target_id=str(structure_id),
          detail={"for": str(user_id), "effective_from": effective_from.isoformat()})
    db.commit()


# --------------------------------------------------------------------------- #
# Reading
# --------------------------------------------------------------------------- #


def readable(db: Session, viewer: User, user_id: uuid.UUID) -> User:
    """Own salary always; anybody else's only with the payroll capability.

    Deliberately not the hierarchy. A manager approves this person's leave and
    their expenses, and neither is a reason to know what they earn — the same
    judgement Core HR makes about a home address, held more strictly because pay
    is the one figure colleagues compare with each other.
    """
    subject = db.get(User, user_id)
    if subject is None or subject.org_id != viewer.org_id:
        raise PayrollError("employee_not_found", "Employee not found", 404)
    if subject.id == viewer.id or can_manage(viewer):
        return subject
    raise PayrollError("not_permitted", "You may only view your own salary.", 403)


def uncovered(db: Session, viewer: User) -> list[User]:
    """Active employees with no salary structure at all.

    The report that makes the module usable on day one: a company sets this up
    by working through the people who are missing, and without the list that is
    a manual cross-check against the employee roster.
    """
    _require_manager(viewer)
    with_structure = select(SalaryStructure.user_id).where(
        SalaryStructure.org_id == viewer.org_id
    )
    return list(
        db.scalars(
            select(User)
            .where(
                User.org_id == viewer.org_id,
                User.is_active.is_(True),
                User.id.not_in(with_structure),
            )
            .order_by(User.full_name)
        )
    )
