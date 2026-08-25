"""Investment declarations: the employee's side of income tax.

The rules that matter:

**A submitted declaration is still editable by the employee.** A declaration is
an estimate for the year, and people genuinely do invest more in November than
they said in April. Verification is what closes it — not submission.

**Declared and verified are two facts, not one field.** Payroll honours the
declared figure until somebody checks proofs, and the verified figure after. A
single amount column would lose the ability to answer "why did my TDS jump in
February", which is the single most-asked payroll question of the year.

**The regime choice is the employee's.** HR may verify amounts; it may not
change which regime somebody elected, because that is a choice with consequences
they own. There is no code path for it.

**Proof lives in the Core HR document file.** That module already handles
upload, permission and download; a parallel store here would be a second place to
get an employee's personal documents wrong.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import audit
from app.core import taxslabs
from app.models import (
    DeclarationStatus,
    EmployeeDocument,
    ItemStatus,
    Regime,
    TaxDeclaration,
    TaxDeclarationItem,
    User,
)
from app.services import incometax as tax_svc
from app.services import payroll as payroll_svc


class DeclarationError(Exception):
    """A rule said no, with a code the console can branch on."""

    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _now() -> datetime:
    return datetime.now(timezone.utc)


def current_financial_year() -> int:
    today = date.today()
    return taxslabs.financial_year_of(today.year, today.month)


def can_verify(viewer: User) -> bool:
    """Who may check proofs. The same capability as salaries.

    A declaration reveals what somebody invests, insures and borrows — closer to
    a salary than to an expense claim, and held to the same line.
    """
    return payroll_svc.can_manage(viewer)


def readable(db: Session, viewer: User, user_id: uuid.UUID) -> User:
    """Own declaration always; anybody else's only with the payroll capability."""
    subject = db.get(User, user_id)
    if subject is None or subject.org_id != viewer.org_id:
        raise DeclarationError("employee_not_found", "Employee not found", 404)
    if subject.id == viewer.id or can_verify(viewer):
        return subject
    raise DeclarationError(
        "not_permitted", "You may only view your own declaration.", 403
    )


def get_or_create(
    db: Session, viewer: User, user_id: uuid.UUID, financial_year: int
) -> TaxDeclaration:
    """The declaration for one person and year, created empty on first use.

    Created rather than 404ing: the first thing anybody does with this screen is
    open it, and an empty declaration with the default regime is the honest
    starting state — the new regime is the default in law.
    """
    subject = readable(db, viewer, user_id)
    row = db.scalar(
        select(TaxDeclaration).where(
            TaxDeclaration.user_id == subject.id,
            TaxDeclaration.financial_year == financial_year,
        )
    )
    if row is None:
        row = TaxDeclaration(
            org_id=viewer.org_id,
            user_id=subject.id,
            financial_year=financial_year,
            regime=Regime.NEW.value,
            status=DeclarationStatus.DRAFT.value,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def get(db: Session, viewer: User, declaration_id: uuid.UUID) -> TaxDeclaration:
    row = db.get(TaxDeclaration, declaration_id)
    if row is None or row.org_id != viewer.org_id:
        raise DeclarationError("not_found", "Declaration not found", 404)
    readable(db, viewer, row.user_id)
    return row


def _require_owner(declaration: TaxDeclaration, viewer: User) -> None:
    """Only the employee edits their own claims.

    An administrator verifies amounts; they do not enter them. A declaration
    somebody else filled in is not a declaration — it is an assumption with the
    employee's name on it.
    """
    if declaration.user_id != viewer.id:
        raise DeclarationError(
            "not_permitted", "Only the employee may edit their declaration.", 403
        )
    if not declaration.is_editable:
        raise DeclarationError(
            "not_editable",
            f"This declaration is {declaration.status} and can no longer be "
            "changed. Ask HR to reopen it.",
            409,
        )


def set_regime(
    db: Session,
    viewer: User,
    declaration_id: uuid.UUID,
    regime: str,
    *,
    request: Request | None = None,
) -> TaxDeclaration:
    """Elect the old or the new regime.

    The employee's, always. There is no administrator path to this — the choice
    has consequences they own, and an HR user who could change it could
    materially change somebody's take-home without their knowing.
    """
    row = get(db, viewer, declaration_id)
    _require_owner(row, viewer)
    if regime not in (Regime.OLD.value, Regime.NEW.value):
        raise DeclarationError("bad_regime", "Choose the old or the new regime.")

    previous = row.regime
    row.regime = regime
    audit(db, org_id=viewer.org_id, actor=viewer, action="tax.regime_chosen",
          request=request, target_type="tax_declaration", target_id=str(row.id),
          detail={"financial_year": row.financial_year, "from": previous,
                  "to": regime})
    db.commit()
    db.refresh(row)
    return row


def upsert_item(
    db: Session,
    viewer: User,
    declaration_id: uuid.UUID,
    payload,
    *,
    request: Request | None = None,
) -> TaxDeclarationItem:
    """Add or revise one claim.

    Upsert on the section, because the unique constraint says one row per
    section and two "80C" rows would each be half an answer with the cap applied
    to whichever was summed first.

    Revising a **verified** item resets it to declared: the amount changed, so
    the previous check no longer covers it, and leaving it verified would let
    somebody raise a figure after it was approved.
    """
    row = get(db, viewer, declaration_id)
    _require_owner(row, viewer)

    section = payload.section.strip().upper()
    item = db.scalar(
        select(TaxDeclarationItem).where(
            TaxDeclarationItem.declaration_id == row.id,
            TaxDeclarationItem.section == section,
        )
    )
    if item is None:
        item = TaxDeclarationItem(
            org_id=viewer.org_id, declaration_id=row.id, section=section
        )
        db.add(item)
    elif item.declared_amount != payload.declared_amount:
        item.verified_amount = None
        item.status = ItemStatus.DECLARED.value

    item.declared_amount = payload.declared_amount
    item.label = (payload.label or "").strip() or None
    if payload.note is not None:
        item.note = payload.note.strip() or None

    audit(db, org_id=viewer.org_id, actor=viewer, action="tax.item_declared",
          request=request, target_type="tax_declaration", target_id=str(row.id),
          detail={"section": section, "amount": payload.declared_amount,
                  "financial_year": row.financial_year})
    db.commit()
    db.refresh(item)
    return item


def delete_item(
    db: Session, viewer: User, item_id: uuid.UUID, *, request: Request | None = None
) -> None:
    item = db.get(TaxDeclarationItem, item_id)
    if item is None or item.org_id != viewer.org_id:
        raise DeclarationError("item_not_found", "Claim not found", 404)
    row = get(db, viewer, item.declaration_id)
    _require_owner(row, viewer)

    section = item.section
    db.delete(item)
    audit(db, org_id=viewer.org_id, actor=viewer, action="tax.item_removed",
          request=request, target_type="tax_declaration", target_id=str(row.id),
          detail={"section": section})
    db.commit()


def attach_proof(
    db: Session,
    viewer: User,
    item_id: uuid.UUID,
    document_id: uuid.UUID,
    *,
    request: Request | None = None,
) -> TaxDeclarationItem:
    """Point a claim at a document already in the employee's file.

    Takes a document id rather than a file: the upload happens through Core HR,
    which owns storage and permission, and this records which of the person's
    documents evidences which claim. Two upload paths for one employee's
    documents is two places to get it wrong.
    """
    item = db.get(TaxDeclarationItem, item_id)
    if item is None or item.org_id != viewer.org_id:
        raise DeclarationError("item_not_found", "Claim not found", 404)
    row = get(db, viewer, item.declaration_id)
    _require_owner(row, viewer)

    document = db.get(EmployeeDocument, document_id)
    if document is None or document.org_id != viewer.org_id:
        raise DeclarationError("document_not_found", "Document not found", 404)
    if document.user_id != row.user_id:
        # Attaching somebody else's document as proof of your own claim is the
        # hole this check exists to close.
        raise DeclarationError(
            "wrong_owner", "That document belongs to somebody else.", 403
        )

    item.document_id = document.id
    item.status = ItemStatus.PROOF_SUBMITTED.value
    audit(db, org_id=viewer.org_id, actor=viewer, action="tax.proof_attached",
          request=request, target_type="tax_declaration", target_id=str(row.id),
          detail={"section": item.section, "document_id": str(document.id)})
    db.commit()
    db.refresh(item)
    return item


def submit(
    db: Session, viewer: User, declaration_id: uuid.UUID, *, request: Request | None = None
) -> TaxDeclaration:
    """Tell payroll to start honouring it.

    Still editable afterwards — see the module docstring. Submitting is the
    employee saying "use this from now on", not "I am finished".
    """
    row = get(db, viewer, declaration_id)
    _require_owner(row, viewer)
    if not row.items:
        # A regime choice with no claims is legitimate for the new regime, which
        # allows none — so this refuses only where claims would have mattered.
        if row.regime == Regime.OLD.value:
            raise DeclarationError(
                "no_items",
                "Add at least one claim, or elect the new regime, which allows "
                "none.",
            )

    row.status = DeclarationStatus.SUBMITTED.value
    row.submitted_at = _now()
    audit(db, org_id=viewer.org_id, actor=viewer, action="tax.declaration_submitted",
          request=request, target_type="tax_declaration", target_id=str(row.id),
          detail={"financial_year": row.financial_year, "regime": row.regime,
                  "items": len(row.items)})
    db.commit()
    db.refresh(row)
    return row


def verify_item(
    db: Session,
    viewer: User,
    item_id: uuid.UUID,
    payload,
    *,
    request: Request | None = None,
) -> TaxDeclarationItem:
    """Record what a proof actually evidences.

    ``verified_amount`` may be less than declared, which is the ordinary case:
    somebody declared ₹1,50,000 of 80C in April and produced receipts for
    ₹1,10,000 in February. Payroll switches to the verified figure the moment it
    is set, which is why TDS changes that month.
    """
    if not can_verify(viewer):
        raise DeclarationError(
            "not_permitted", "You may not verify declarations.", 403
        )
    item = db.get(TaxDeclarationItem, item_id)
    if item is None or item.org_id != viewer.org_id:
        raise DeclarationError("item_not_found", "Claim not found", 404)
    row = db.get(TaxDeclaration, item.declaration_id)

    if payload.reject:
        if not (payload.note or "").strip():
            raise DeclarationError(
                "note_required",
                "Say why it is rejected — the employee's TDS will change and "
                "they will ask.",
            )
        item.status = ItemStatus.REJECTED.value
        item.verified_amount = 0
    else:
        item.status = ItemStatus.VERIFIED.value
        item.verified_amount = (
            payload.verified_amount
            if payload.verified_amount is not None
            else item.declared_amount
        )
    if payload.note is not None:
        item.note = payload.note.strip() or None

    audit(db, org_id=viewer.org_id, actor=viewer, action="tax.item_verified",
          request=request, target_type="tax_declaration", target_id=str(row.id),
          detail={"for": str(row.user_id), "section": item.section,
                  "declared": item.declared_amount,
                  "verified": item.verified_amount,
                  "rejected": payload.reject, "note": item.note})
    db.commit()
    db.refresh(item)
    return item


def close(
    db: Session,
    viewer: User,
    declaration_id: uuid.UUID,
    payload,
    *,
    request: Request | None = None,
) -> TaxDeclaration:
    """Mark the whole declaration verified, or reopen it.

    Closing is what stops the employee editing. Reopening exists because
    somebody always produces a receipt the day after the deadline, and a system
    with no way back forces that correction to happen in a spreadsheet.
    """
    if not can_verify(viewer):
        raise DeclarationError(
            "not_permitted", "You may not verify declarations.", 403
        )
    row = get(db, viewer, declaration_id)

    if payload.reopen:
        row.status = DeclarationStatus.SUBMITTED.value
        row.verified_at = None
        row.verified_by = None
        action = "tax.declaration_reopened"
    else:
        row.status = DeclarationStatus.VERIFIED.value
        row.verified_at = _now()
        row.verified_by = viewer.id
        action = "tax.declaration_verified"
    if payload.note is not None:
        row.note = payload.note.strip() or None

    audit(db, org_id=viewer.org_id, actor=viewer, action=action,
          request=request, target_type="tax_declaration", target_id=str(row.id),
          detail={"for": str(row.user_id), "financial_year": row.financial_year})
    db.commit()
    db.refresh(row)
    return row


# --------------------------------------------------------------------------- #
# Estimation
# --------------------------------------------------------------------------- #


def estimate(
    db: Session,
    viewer: User,
    declaration_id: uuid.UUID,
    *,
    annual_income: int,
) -> dict:
    """What this declaration would cost under each regime.

    Both regimes, always. The whole point of the choice is the comparison, and
    an employee looking at one number cannot make it — this is the screen that
    stops somebody electing the old regime and losing money by it.
    """
    row = get(db, viewer, declaration_id)
    deductions: dict[str, int] = {}
    for item in row.items:
        amount = item.effective_amount
        if amount:
            deductions[item.section] = deductions.get(item.section, 0) + amount

    # The same band the pay run will use, so the comparison on screen and the
    # figure on the payslip cannot disagree.
    from app.models import EmployeeProfile

    profile = db.get(EmployeeProfile, row.user_id)
    age_band = taxslabs.age_band_on(
        profile.date_of_birth if profile else None, row.financial_year
    )

    out = {}
    for regime in (Regime.OLD.value, Regime.NEW.value):
        breakdown = tax_svc.annual_tax(
            gross_income=annual_income,
            financial_year=row.financial_year,
            regime=regime,
            deductions=deductions,
            age_band=age_band,
        )
        out[regime] = breakdown
    return {
        "chosen": row.regime,
        "financial_year": row.financial_year,
        "year_label": taxslabs.year_label(row.financial_year),
        "provisional": taxslabs.is_provisional(row.financial_year),
        "annual_income": annual_income,
        "old": out[Regime.OLD.value],
        "new": out[Regime.NEW.value],
    }
