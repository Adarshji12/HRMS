"""Expense claim rules: what may be edited, who may approve, who may pay.

A sibling of ``services/leave`` and ``services/regularization``, and it borrows
their conventions: a typed error carrying a code the console branches on, and
every rule here rather than in a handler.

The four that matter:

**A claim's total is computed, never accepted.** ``recompute_total`` sums the
lines and writes the result. A total in a request body is a total the client can
lie about, and the lie is money.

**Lines are editable only in draft.** Submitting is the boundary. A manager who
approved ₹4,000 must not find the claim now says ₹40,000 because a line was
edited afterwards — which is the same reason ``timesheet_approvals`` freezes its
totals, and why ``approved_amount`` is captured at approval as the checkable
record of what was signed off.

**Approving and paying are different acts by different people.** A manager says
the spend was legitimate; finance says the money has left. Two permissions, two
transitions, and "approved but unpaid" is a first-class state because it is the
one every employee chases.

**Scope comes from the hierarchy service.** Unlike Core HR — where a manager
gets nothing, because line management is not a reason to read somebody's Aadhaar
— an expense claim is exactly a management matter, so the reporting subtree is
the right scope and ``services/hierarchy`` is the single authority for it.
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import date, datetime, timezone

from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import audit
from app.models import (
    ClaimStatus,
    ExpenseCategory,
    ExpenseClaim,
    ExpenseLine,
    Project,
    Role,
    User,
)
from app.services import chains, hierarchy, storage, workflow

log = logging.getLogger(__name__)

#: Same ceiling as every other document upload here: the size of a phone
#: photograph of a paper receipt, which is what almost all of these are.
MAX_RECEIPT_BYTES = 15 * 1024 * 1024

_SAFE_SUFFIX = re.compile(r"^\.[A-Za-z0-9]{1,8}$")

#: How far back a claim may reach. Not a policy engine — one number, because the
#: real purpose is refusing a receipt from four years ago that no reviewer can
#: sensibly check and no finance period is still open for. A company that needs
#: a different window will say so.
MAX_CLAIM_AGE_DAYS = 365


class ExpenseError(Exception):
    """A rule said no, with a code the console can branch on."""

    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _suffix_for(file_name: str) -> str:
    suffix = ("." + file_name.rsplit(".", 1)[-1]) if "." in file_name else ""
    return suffix if _SAFE_SUFFIX.match(suffix) else ""


# --------------------------------------------------------------------------- #
# Permissions
# --------------------------------------------------------------------------- #


def is_approver(viewer: User) -> bool:
    """May sign off somebody's claim. Role first, flag second."""
    return (
        viewer.role in (Role.OWNER.value, Role.ADMIN.value, Role.MANAGER.value)
        and viewer.can_approve_expenses
    )


def is_finance(viewer: User) -> bool:
    """May mark an approved claim paid.

    Administrators only, not managers: a manager approving their own team's
    spend *and* recording it as paid is the segregation this exists to keep.
    """
    return viewer.role in (Role.OWNER.value, Role.ADMIN.value) and viewer.can_reimburse_expenses


def scope_ids(db: Session, viewer: User) -> list[uuid.UUID] | None:
    """Whose claims this person may see. None means the whole organisation.

    Delegated to ``services/hierarchy`` rather than re-derived. There is exactly
    one answer in this codebase to "whose data may this manager see" and this
    module is not writing a second one.
    """
    return hierarchy.visible_user_ids(db, viewer)


def ensure_in_scope(db: Session, viewer: User, user_id: uuid.UUID) -> User:
    subject = db.get(User, user_id)
    if subject is None or subject.org_id != viewer.org_id:
        raise ExpenseError("employee_not_found", "Employee not found", 404)
    if subject.id == viewer.id:
        return subject
    allowed = scope_ids(db, viewer)
    if allowed is not None and subject.id not in allowed:
        raise ExpenseError(
            "out_of_scope", "That employee is not in your team.", 403
        )
    return subject


# --------------------------------------------------------------------------- #
# Categories
# --------------------------------------------------------------------------- #


def get_category(db: Session, org_id: uuid.UUID, category_id: uuid.UUID) -> ExpenseCategory:
    row = db.get(ExpenseCategory, category_id)
    if row is None or row.org_id != org_id:
        raise ExpenseError("category_not_found", "Expense category not found", 404)
    return row


def list_categories(
    db: Session, org_id: uuid.UUID, *, active_only: bool = False
) -> list[ExpenseCategory]:
    statement = select(ExpenseCategory).where(ExpenseCategory.org_id == org_id)
    if active_only:
        statement = statement.where(ExpenseCategory.is_active.is_(True))
    return list(db.scalars(statement.order_by(ExpenseCategory.name)))


def create_category(
    db: Session, viewer: User, payload, *, request: Request | None = None
) -> ExpenseCategory:
    if viewer.role not in (Role.OWNER.value, Role.ADMIN.value):
        raise ExpenseError(
            "not_permitted", "Only an administrator may manage categories.", 403
        )
    name = payload.name.strip()
    clash = db.scalar(
        select(ExpenseCategory).where(
            ExpenseCategory.org_id == viewer.org_id,
            func.lower(ExpenseCategory.name) == name.lower(),
        )
    )
    if clash is not None:
        # Caught here as well as by the unique index so the message names the
        # problem rather than surfacing an IntegrityError.
        raise ExpenseError(
            "duplicate_name", f"A category called {name!r} already exists.", 409
        )

    row = ExpenseCategory(
        org_id=viewer.org_id,
        name=name,
        description=(payload.description or "").strip() or None,
        requires_receipt=payload.requires_receipt,
        max_amount=payload.max_amount,
        is_active=payload.is_active,
    )
    db.add(row)
    audit(db, org_id=viewer.org_id, actor=viewer, action="expenses.category_created",
          request=request, target_type="expense_category", target_id=str(row.id),
          detail={"name": row.name, "requires_receipt": row.requires_receipt,
                  "max_amount": row.max_amount})
    db.commit()
    db.refresh(row)
    return row


def update_category(
    db: Session,
    viewer: User,
    category_id: uuid.UUID,
    payload,
    *,
    request: Request | None = None,
) -> ExpenseCategory:
    if viewer.role not in (Role.OWNER.value, Role.ADMIN.value):
        raise ExpenseError(
            "not_permitted", "Only an administrator may manage categories.", 403
        )
    row = get_category(db, viewer.org_id, category_id)
    changes = payload.model_dump(exclude_unset=True)
    touched = []
    for field, value in changes.items():
        if isinstance(value, str):
            value = value.strip() or None
        if getattr(row, field, None) != value:
            setattr(row, field, value)
            touched.append(field)
    if touched:
        audit(db, org_id=viewer.org_id, actor=viewer, action="expenses.category_updated",
              request=request, target_type="expense_category", target_id=str(row.id),
              detail={"fields": sorted(touched)})
        db.commit()
        db.refresh(row)
    return row


# --------------------------------------------------------------------------- #
# Claims
# --------------------------------------------------------------------------- #


def get_claim(db: Session, viewer: User, claim_id: uuid.UUID) -> ExpenseClaim:
    """One claim, if this caller may see it.

    404 on a cross-tenant id, 403 on an in-tenant claim outside the caller's
    scope — the first would confirm an id exists elsewhere, the second is a real
    refusal the console should explain.
    """
    row = db.get(ExpenseClaim, claim_id)
    if row is None or row.org_id != viewer.org_id:
        raise ExpenseError("not_found", "Claim not found", 404)
    if row.user_id == viewer.id:
        return row
    if not is_approver(viewer) and not is_finance(viewer):
        raise ExpenseError("not_permitted", "You may not view this claim.", 403)
    allowed = scope_ids(db, viewer)
    if allowed is not None and row.user_id not in allowed:
        # An approval chain can route a claim to somebody outside the requester's
        # line management — Finance at level 2 is the ordinary case — and that
        # reviewer is out of scope by the rule above however the chain is
        # configured. Being the rung the claim is *currently* waiting on is an
        # additional allow for exactly this one record, and never an override of
        # any other denial: see `chains.is_current_reviewer`.
        if not chains.is_current_reviewer(db, row.id, viewer):
            raise ExpenseError("out_of_scope", "That claim is not in your team.", 403)
    return row


def recompute_total(db: Session, claim: ExpenseClaim) -> int:
    """Sum the lines onto the claim.

    The single place a total is written. Called after every line mutation, so a
    claim's total cannot drift from the lines it is made of — and never fed from
    a request body, because a total the client sends is a total the client can
    lie about.
    """
    total = db.scalar(
        select(func.coalesce(func.sum(ExpenseLine.amount), 0)).where(
            ExpenseLine.claim_id == claim.id
        )
    ) or 0
    claim.total_amount = int(total)
    return claim.total_amount


def create_claim(
    db: Session, viewer: User, payload, *, request: Request | None = None
) -> ExpenseClaim:
    """Start a draft. Own claim unless filing for somebody in scope."""
    subject = viewer
    on_behalf = False
    if payload.user_id is not None and payload.user_id != viewer.id:
        if not is_approver(viewer):
            raise ExpenseError(
                "not_permitted", "You may only claim for yourself.", 403
            )
        subject = ensure_in_scope(db, viewer, payload.user_id)
        on_behalf = True

    if payload.project_id is not None:
        project = db.get(Project, payload.project_id)
        if project is None or project.org_id != viewer.org_id:
            raise ExpenseError("project_not_found", "Project not found", 404)

    row = ExpenseClaim(
        org_id=viewer.org_id,
        user_id=subject.id,
        created_by_user_id=viewer.id,
        title=payload.title.strip(),
        note=(payload.note or "").strip() or None,
        project_id=payload.project_id,
        status=ClaimStatus.DRAFT.value,
        total_amount=0,
    )
    db.add(row)
    audit(db, org_id=viewer.org_id, actor=viewer, action="expenses.claim_created",
          request=request, target_type="expense_claim", target_id=str(row.id),
          detail={"for": str(subject.id), "on_behalf": on_behalf, "title": row.title})
    db.commit()
    db.refresh(row)
    return row


def _require_editable(claim: ExpenseClaim, viewer: User) -> None:
    """The claim's owner, while it is still a draft.

    An approver may *see* a draft in their team but may not edit it: rewording
    somebody's claim and then approving it would leave nobody having actually
    made the claim.
    """
    if claim.user_id != viewer.id and claim.created_by_user_id != viewer.id:
        raise ExpenseError("not_permitted", "This is not your claim to edit.", 403)
    if not claim.status_enum.is_editable:
        raise ExpenseError(
            "not_editable",
            "A submitted claim cannot be changed. Ask for it to be returned, or "
            "start a new one.",
            409,
        )


def update_claim(
    db: Session,
    viewer: User,
    claim_id: uuid.UUID,
    payload,
    *,
    request: Request | None = None,
) -> ExpenseClaim:
    claim = get_claim(db, viewer, claim_id)
    _require_editable(claim, viewer)

    changes = payload.model_dump(exclude_unset=True)
    for field, value in changes.items():
        if isinstance(value, str):
            value = value.strip() or None
        setattr(claim, field, value)
    db.commit()
    db.refresh(claim)
    return claim


def delete_claim(
    db: Session, viewer: User, claim_id: uuid.UUID, *, request: Request | None = None
) -> None:
    """Discard a draft, and its receipts with it.

    Only a draft. A submitted claim is cancelled rather than deleted — somebody
    reviewed it, and a review of a thing that no longer exists is not a record.
    """
    claim = get_claim(db, viewer, claim_id)
    _require_editable(claim, viewer)
    keys = [line.receipt_key for line in claim.lines if line.receipt_key]

    db.delete(claim)
    audit(db, org_id=viewer.org_id, actor=viewer, action="expenses.claim_deleted",
          request=request, target_type="expense_claim", target_id=str(claim_id),
          detail={"for": str(claim.user_id)})
    db.commit()
    # After the commit: a failed object delete must not roll back the rows, or a
    # retry loops forever on a file the backend has already lost.
    for key in keys:
        storage.delete(key)


# --------------------------------------------------------------------------- #
# Lines
# --------------------------------------------------------------------------- #


def _check_line(db: Session, org_id: uuid.UUID, category: ExpenseCategory, payload) -> None:
    if not category.is_active:
        raise ExpenseError(
            "category_inactive", f"{category.name} is no longer claimable."
        )
    if payload.spent_on > date.today():
        raise ExpenseError(
            "future_date", "You cannot claim for a date that has not happened yet."
        )
    if (date.today() - payload.spent_on).days > MAX_CLAIM_AGE_DAYS:
        raise ExpenseError(
            "too_old",
            f"Expenses older than {MAX_CLAIM_AGE_DAYS} days cannot be claimed.",
        )
    if category.max_amount is not None and payload.amount > category.max_amount:
        raise ExpenseError(
            "over_category_limit",
            f"{category.name} is capped at "
            f"{category.max_amount / 100:,.2f} per item.",
        )


def add_line(
    db: Session,
    viewer: User,
    claim_id: uuid.UUID,
    payload,
    *,
    request: Request | None = None,
) -> ExpenseLine:
    claim = get_claim(db, viewer, claim_id)
    _require_editable(claim, viewer)
    category = get_category(db, viewer.org_id, payload.category_id)
    _check_line(db, viewer.org_id, category, payload)

    line = ExpenseLine(
        org_id=viewer.org_id,
        claim_id=claim.id,
        category_id=category.id,
        spent_on=payload.spent_on,
        description=payload.description.strip(),
        merchant=(payload.merchant or "").strip() or None,
        amount=payload.amount,
    )
    db.add(line)
    db.flush()
    recompute_total(db, claim)
    db.commit()
    db.refresh(line)
    return line


def get_line(db: Session, viewer: User, line_id: uuid.UUID) -> ExpenseLine:
    row = db.get(ExpenseLine, line_id)
    if row is None or row.org_id != viewer.org_id:
        raise ExpenseError("line_not_found", "Expense line not found", 404)
    # Authorised through its claim, so the line routes cannot drift from the
    # claim's own rule.
    get_claim(db, viewer, row.claim_id)
    return row


def update_line(
    db: Session,
    viewer: User,
    line_id: uuid.UUID,
    payload,
    *,
    request: Request | None = None,
) -> ExpenseLine:
    line = get_line(db, viewer, line_id)
    claim = db.get(ExpenseClaim, line.claim_id)
    _require_editable(claim, viewer)

    changes = payload.model_dump(exclude_unset=True)
    category = get_category(
        db, viewer.org_id, changes.get("category_id", line.category_id)
    )
    # Validated against the merged values, not the incoming ones: changing only
    # the amount still has to be checked against the existing category's cap.
    merged = type("Merged", (), {
        "spent_on": changes.get("spent_on", line.spent_on),
        "amount": changes.get("amount", line.amount),
    })()
    _check_line(db, viewer.org_id, category, merged)

    for field, value in changes.items():
        if isinstance(value, str):
            value = value.strip()
        setattr(line, field, value)
    db.flush()
    recompute_total(db, claim)
    db.commit()
    db.refresh(line)
    return line


def delete_line(
    db: Session, viewer: User, line_id: uuid.UUID, *, request: Request | None = None
) -> None:
    line = get_line(db, viewer, line_id)
    claim = db.get(ExpenseClaim, line.claim_id)
    _require_editable(claim, viewer)
    key = line.receipt_key

    db.delete(line)
    db.flush()
    recompute_total(db, claim)
    db.commit()
    if key:
        storage.delete(key)


def attach_receipt(
    db: Session,
    viewer: User,
    line_id: uuid.UUID,
    *,
    file_name: str,
    content_type: str,
    raw: bytes,
    request: Request | None = None,
) -> ExpenseLine:
    """Store the receipt for one line, replacing any previous one.

    Replacing rather than accumulating: a line is one expense, and a second
    receipt on it almost always means a second expense that should be its own
    line. The old object is deleted after the commit, for the same reason
    ``delete_line`` does it in that order.
    """
    line = get_line(db, viewer, line_id)
    claim = db.get(ExpenseClaim, line.claim_id)
    _require_editable(claim, viewer)

    if not raw:
        raise ExpenseError("empty_upload", "The file is empty.")
    if len(raw) > MAX_RECEIPT_BYTES:
        raise ExpenseError(
            "too_large",
            f"Receipts are limited to {MAX_RECEIPT_BYTES // (1024 * 1024)} MB.",
            413,
        )

    previous = line.receipt_key
    key = storage.build_key(
        viewer.org_id, claim.user_id, _now(), uuid.uuid4(),
        suffix=_suffix_for(file_name),
    )
    try:
        size = storage.backend().put(key, raw, content_type or "application/octet-stream")
    except storage.StorageError as exc:
        raise ExpenseError("storage_failed", f"Could not store the receipt: {exc}", 503) from exc

    line.receipt_key = key
    line.receipt_name = (file_name or "")[:255] or None
    line.receipt_type = (content_type or "")[:120] or None
    line.receipt_size = size
    audit(db, org_id=viewer.org_id, actor=viewer, action="expenses.receipt_attached",
          request=request, target_type="expense_line", target_id=str(line.id),
          detail={"claim_id": str(claim.id), "replaced": previous is not None})
    db.commit()
    db.refresh(line)
    if previous and previous != key:
        storage.delete(previous)
    return line


def serve_receipt(db: Session, viewer: User, line_id: uuid.UUID):
    line = get_line(db, viewer, line_id)
    if not line.receipt_key:
        raise ExpenseError("no_receipt", "No receipt on this line.", 404)
    try:
        return line, storage.serve(line.receipt_key)
    except (FileNotFoundError, storage.StorageError):
        raise ExpenseError("data_missing", "The stored receipt is missing.", 404) from None


# --------------------------------------------------------------------------- #
# Transitions
# --------------------------------------------------------------------------- #


def submit(
    db: Session, viewer: User, claim_id: uuid.UUID, *, request: Request | None = None
) -> ExpenseClaim:
    """Send a draft for approval, and freeze its lines.

    Every check that makes a claim reviewable happens here rather than at
    approval: the person who can fix a missing receipt is the claimant, and
    telling them at submission is the difference between a five-second fix and a
    round trip through their manager.
    """
    claim = get_claim(db, viewer, claim_id)
    _require_editable(claim, viewer)

    lines = list(claim.lines)
    if not lines:
        raise ExpenseError("no_lines", "Add at least one expense before submitting.")

    categories = {
        row.id: row
        for row in db.scalars(
            select(ExpenseCategory).where(
                ExpenseCategory.id.in_({line.category_id for line in lines})
            )
        )
    }
    missing = [
        line.description
        for line in lines
        if categories[line.category_id].requires_receipt and not line.receipt_key
    ]
    if missing:
        raise ExpenseError(
            "receipt_required",
            "These need a receipt before you can submit: " + ", ".join(missing[:5]),
        )

    recompute_total(db, claim)
    if claim.total_amount <= 0:
        raise ExpenseError("zero_total", "A claim must come to more than zero.")

    claim.status = ClaimStatus.SUBMITTED.value
    claim.submitted_at = _now()
    # Cleared, so a resubmitted-after-return claim does not carry the previous
    # reviewer's name against a decision they have not made.
    claim.reviewed_by = None
    claim.reviewed_at = None
    claim.review_note = None

    # A chain begins when the request does, not when somebody first looks at
    # it: a lazily-written chain has its first rung consumed by whoever
    # happened to open the queue. Returns [] and does nothing when this flow
    # has no chain configured, which is most companies.
    chains.start_for(db, kind="expense", record_id=claim.id, subject=viewer, record=claim)

    audit(db, org_id=viewer.org_id, actor=viewer, action="expenses.submitted",
          request=request, target_type="expense_claim", target_id=str(claim.id),
          detail={"for": str(claim.user_id), "total": claim.total_amount,
                  "lines": len(lines)})
    db.commit()
    db.refresh(claim)
    return claim


def review(
    db: Session,
    viewer: User,
    claim_id: uuid.UUID,
    payload,
    *,
    request: Request | None = None,
) -> ExpenseClaim:
    """Approve or reject a submitted claim.

    One endpoint with two outcomes, like regularization: deciding is a single
    transition, and splitting it would duplicate the self-review and
    already-decided guards across two handlers.
    """
    if not is_approver(viewer):
        raise ExpenseError(
            "not_permitted", "You may not approve expense claims.", 403
        )
    claim = get_claim(db, viewer, claim_id)
    approve = payload.status == ClaimStatus.APPROVED.value

    def freeze_the_approved_figure() -> None:
        # The figure that was signed off. Lines are already frozen, so this
        # should always equal total_amount — the column is what makes that
        # checkable rather than assumed.
        claim.approved_amount = claim.total_amount

    # Not-submitted, self-review, reason-on-rejection, the stamp and the audit
    # row all live in the kernel now. `EXPENSE` is where this flow's answers to
    # those questions are written down, next to the other five flows'.
    workflow.decide(
        db, policy=workflow.EXPENSE, record=claim, reviewer=viewer,
        approve=approve, note=payload.review_note, request=request,
        on_approve=freeze_the_approved_figure,
        detail={"amount": claim.total_amount},
    )
    db.commit()
    db.refresh(claim)
    return claim


def reimburse(
    db: Session,
    viewer: User,
    claim_id: uuid.UUID,
    payload,
    *,
    request: Request | None = None,
) -> ExpenseClaim:
    """Record that an approved claim has been paid. Finance only."""
    if not is_finance(viewer):
        raise ExpenseError(
            "not_permitted", "You may not record reimbursements.", 403
        )
    claim = get_claim(db, viewer, claim_id)
    if claim.status_enum is not ClaimStatus.APPROVED:
        raise ExpenseError(
            "not_approved",
            f"This claim is {claim.status}; only an approved claim can be paid.",
            409,
        )

    claim.status = ClaimStatus.REIMBURSED.value
    claim.reimbursed_at = _now()
    claim.reimbursed_by = viewer.id
    claim.payment_reference = (payload.payment_reference or "").strip() or None

    audit(db, org_id=viewer.org_id, actor=viewer, action="expenses.reimbursed",
          request=request, target_type="expense_claim", target_id=str(claim.id),
          detail={"for": str(claim.user_id), "amount": claim.approved_amount,
                  "reference": claim.payment_reference})
    db.commit()
    db.refresh(claim)
    return claim


def cancel(
    db: Session, viewer: User, claim_id: uuid.UUID, *, request: Request | None = None
) -> ExpenseClaim:
    """Withdraw a claim before it is decided.

    The claimant's own act, and only while nothing has been decided. A paid claim
    cannot be cancelled — the money has moved, and the correction for that is a
    recovery, not an edit to this row.
    """
    claim = get_claim(db, viewer, claim_id)
    if claim.user_id != viewer.id and not is_approver(viewer):
        raise ExpenseError("not_permitted", "This is not your claim.", 403)
    if claim.status_enum not in (ClaimStatus.DRAFT, ClaimStatus.SUBMITTED):
        raise ExpenseError(
            "not_cancellable",
            f"A {claim.status} claim cannot be cancelled.",
            409,
        )

    claim.status = ClaimStatus.CANCELLED.value
    audit(db, org_id=viewer.org_id, actor=viewer, action="expenses.cancelled",
          request=request, target_type="expense_claim", target_id=str(claim.id),
          detail={"for": str(claim.user_id)})
    db.commit()
    db.refresh(claim)
    return claim


# --------------------------------------------------------------------------- #
# Reading
# --------------------------------------------------------------------------- #


def list_claims(
    db: Session,
    viewer: User,
    *,
    mine: bool = False,
    user_id: uuid.UUID | None = None,
    status: str | None = None,
) -> list[ExpenseClaim]:
    """Claims this caller may see.

    ``mine`` is explicit rather than inferred from the role, so "my claims" and
    "my team's claims" are two requests a manager can make deliberately instead
    of one list they have to filter by eye.
    """
    statement = select(ExpenseClaim).where(ExpenseClaim.org_id == viewer.org_id)

    if mine:
        statement = statement.where(ExpenseClaim.user_id == viewer.id)
    elif not (is_approver(viewer) or is_finance(viewer)):
        statement = statement.where(ExpenseClaim.user_id == viewer.id)
    else:
        allowed = scope_ids(db, viewer)
        if allowed is not None:
            # Their own claims are always visible to them, even though a manager
            # is not inside their own reporting subtree.
            statement = statement.where(
                ExpenseClaim.user_id.in_(list(allowed) + [viewer.id])
            )
        if user_id is not None:
            statement = statement.where(ExpenseClaim.user_id == user_id)

    if status:
        statement = statement.where(ExpenseClaim.status == status)
    return list(db.scalars(statement.order_by(ExpenseClaim.created_at.desc())))


def review_queue(db: Session, viewer: User) -> list[ExpenseClaim]:
    """Submitted claims awaiting this approver's decision."""
    if not is_approver(viewer):
        raise ExpenseError("not_permitted", "You may not approve expense claims.", 403)
    statement = select(ExpenseClaim).where(
        ExpenseClaim.org_id == viewer.org_id,
        ExpenseClaim.status == ClaimStatus.SUBMITTED.value,
        # Never your own, since you cannot decide it — showing it in the queue
        # would be an action that always fails.
        ExpenseClaim.user_id != viewer.id,
    )
    allowed = scope_ids(db, viewer)
    if allowed is not None:
        statement = statement.where(ExpenseClaim.user_id.in_(allowed))
    return list(db.scalars(statement.order_by(ExpenseClaim.submitted_at)))


def payment_queue(db: Session, viewer: User) -> list[ExpenseClaim]:
    """Approved and unpaid — the state every employee chases."""
    if not is_finance(viewer):
        raise ExpenseError("not_permitted", "You may not record reimbursements.", 403)
    return list(
        db.scalars(
            select(ExpenseClaim)
            .where(
                ExpenseClaim.org_id == viewer.org_id,
                ExpenseClaim.status == ClaimStatus.APPROVED.value,
            )
            .order_by(ExpenseClaim.reviewed_at)
        )
    )


def summary(db: Session, viewer: User, *, user_id: uuid.UUID | None = None) -> dict:
    """Totals by status, for the tiles on the claims page.

    One grouped query rather than five counts. ``outstanding`` is the number
    that matters: approved but not yet paid, which is what somebody is owed
    right now.
    """
    statement = (
        select(ExpenseClaim.status, func.count(ExpenseClaim.id),
               func.coalesce(func.sum(ExpenseClaim.total_amount), 0))
        .where(ExpenseClaim.org_id == viewer.org_id)
        .group_by(ExpenseClaim.status)
    )
    subject = user_id if user_id is not None else (
        None if (is_approver(viewer) or is_finance(viewer)) else viewer.id
    )
    if subject is not None:
        statement = statement.where(ExpenseClaim.user_id == subject)
    elif is_approver(viewer):
        allowed = scope_ids(db, viewer)
        if allowed is not None:
            statement = statement.where(
                ExpenseClaim.user_id.in_(list(allowed) + [viewer.id])
            )

    by_status = {
        row[0]: {"count": int(row[1]), "amount": int(row[2])}
        for row in db.execute(statement)
    }
    return {
        "by_status": by_status,
        "outstanding_amount": by_status.get(ClaimStatus.APPROVED.value, {}).get("amount", 0),
        "outstanding_count": by_status.get(ClaimStatus.APPROVED.value, {}).get("count", 0),
        "awaiting_review": by_status.get(ClaimStatus.SUBMITTED.value, {}).get("count", 0),
        "currency": "INR",
    }
