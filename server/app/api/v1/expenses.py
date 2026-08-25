"""Expense claims: categories, claims, lines, receipts, decisions, payment.

Thin, like every router here. Each handler settles who is asking, calls
``app.services.expenses``, and turns an ``ExpenseError`` into a typed response.

Three things that are genuinely this file's business.

**One decision endpoint, not ``/approve`` plus ``/reject``.** ``status`` is
required on ``ReviewIn`` and admits only the two outcomes, so deciding is one
transition and the self-review and already-decided guards live in one place. The
same argument regularization makes.

**Approval and payment are separate endpoints with separate permissions.** A
manager saying the spend was legitimate and finance saying the money has left are
different acts, usually days apart by different people. Collapsing them would
make "approved but unpaid" — the state every employee chases — unrepresentable.

**Receipts are served from their own route.** A ``receipt_key`` in a response
body would let a client fetch the file without the permission check that route
runs on every request.
"""

from __future__ import annotations

import uuid
from typing import NoReturn

from fastapi import (
    APIRouter,
    File,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import func, select

from app.api.deps import CurrentUser, DbSession
from app.models import ExpenseCategory, ExpenseClaim, ExpenseLine, Project, User
from app.schemas.expenses import (
    CategoryIn,
    CategoryOut,
    CategoryUpdate,
    ClaimDetailOut,
    ClaimIn,
    ClaimOut,
    ClaimUpdate,
    LineIn,
    LineOut,
    LineUpdate,
    ReimburseIn,
    ReviewIn,
    SummaryOut,
)
from app.services import expenses as svc

router = APIRouter(prefix="/expenses", tags=["expenses"])


def _fail(error: svc.ExpenseError) -> NoReturn:
    raise HTTPException(
        error.status_code, detail={"reason": error.code, "message": error.message}
    )


# --------------------------------------------------------------------------- #
# Serialisation helpers
# --------------------------------------------------------------------------- #


def _names(db, org_id: uuid.UUID, claims) -> dict[uuid.UUID, str]:
    """Display names for exactly the people these claims mention."""
    wanted: set[uuid.UUID] = set()
    for claim in claims:
        wanted.update(
            value
            for value in (
                claim.user_id, claim.reviewed_by, claim.reimbursed_by,
                claim.created_by_user_id,
            )
            if value is not None
        )
    if not wanted:
        return {}
    return {
        row[0]: row[1]
        for row in db.execute(
            select(User.id, User.full_name).where(User.org_id == org_id, User.id.in_(wanted))
        )
    }


def _line_counts(db, claim_ids) -> dict[uuid.UUID, int]:
    """One grouped query rather than a count per row."""
    if not claim_ids:
        return {}
    return {
        row[0]: int(row[1])
        for row in db.execute(
            select(ExpenseLine.claim_id, func.count(ExpenseLine.id))
            .where(ExpenseLine.claim_id.in_(claim_ids))
            .group_by(ExpenseLine.claim_id)
        )
    }


def _projects(db, org_id: uuid.UUID, claims) -> dict[uuid.UUID, str]:
    wanted = {c.project_id for c in claims if c.project_id is not None}
    if not wanted:
        return {}
    return {
        row[0]: row[1]
        for row in db.execute(
            select(Project.id, Project.name).where(
                Project.org_id == org_id, Project.id.in_(wanted)
            )
        )
    }


def _claim_out(
    claim: ExpenseClaim,
    viewer: User,
    *,
    names: dict,
    counts: dict,
    projects: dict,
    db,
) -> ClaimOut:
    out = ClaimOut.model_validate(claim)
    out.user_name = names.get(claim.user_id)
    out.reviewer_name = names.get(claim.reviewed_by)
    out.reimbursed_by_name = names.get(claim.reimbursed_by)
    # Only when somebody else filed it — otherwise every ordinary row grows a
    # redundant "filed by" line repeating the claimant's own name.
    if claim.created_by_user_id and claim.created_by_user_id != claim.user_id:
        out.created_by_name = names.get(claim.created_by_user_id)
    out.project_name = projects.get(claim.project_id)
    out.line_count = counts.get(claim.id, 0)

    state = claim.status_enum
    owns = claim.user_id == viewer.id or claim.created_by_user_id == viewer.id
    out.can_edit = owns and state.is_editable
    out.can_submit = owns and state.is_editable and out.line_count > 0
    out.can_review = (
        svc.is_approver(viewer)
        and state.value == "submitted"
        and claim.user_id != viewer.id
    )
    out.can_reimburse = svc.is_finance(viewer) and state.value == "approved"
    out.can_cancel = (owns or svc.is_approver(viewer)) and state.value in (
        "draft", "submitted",
    )
    return out


def _line_out(line: ExpenseLine, categories: dict) -> LineOut:
    out = LineOut.model_validate(line)
    category = categories.get(line.category_id)
    out.category_name = category.name if category else None
    out.receipt_required = bool(category and category.requires_receipt)
    out.has_receipt = line.receipt_key is not None
    return out


def _detail(db, viewer: User, claim: ExpenseClaim) -> ClaimDetailOut:
    names = _names(db, viewer.org_id, [claim])
    counts = _line_counts(db, [claim.id])
    projects = _projects(db, viewer.org_id, [claim])
    base = _claim_out(claim, viewer, names=names, counts=counts, projects=projects, db=db)
    lines = sorted(claim.lines, key=lambda line: (line.spent_on, line.created_at))
    categories = {
        row.id: row
        for row in db.scalars(
            select(ExpenseCategory).where(
                ExpenseCategory.id.in_({line.category_id for line in lines} or {uuid.uuid4()})
            )
        )
    }
    out = ClaimDetailOut(**base.model_dump())
    out.lines = [_line_out(line, categories) for line in lines]
    return out


def _list_out(db, viewer: User, claims) -> list[ClaimOut]:
    names = _names(db, viewer.org_id, claims)
    counts = _line_counts(db, [c.id for c in claims])
    projects = _projects(db, viewer.org_id, claims)
    return [
        _claim_out(c, viewer, names=names, counts=counts, projects=projects, db=db)
        for c in claims
    ]


# --------------------------------------------------------------------------- #
# Categories
# --------------------------------------------------------------------------- #


@router.get("/categories", response_model=list[CategoryOut])
def list_categories(
    viewer: CurrentUser, db: DbSession, active_only: bool = False
) -> list[CategoryOut]:
    """Open to every employee: you cannot file a claim without knowing what the
    company reimburses, and the list is policy rather than anybody's data."""
    rows = svc.list_categories(db, viewer.org_id, active_only=active_only)
    counts = {
        row[0]: int(row[1])
        for row in db.execute(
            select(ExpenseLine.category_id, func.count(ExpenseLine.id))
            .where(ExpenseLine.org_id == viewer.org_id)
            .group_by(ExpenseLine.category_id)
        )
    }
    out = []
    for row in rows:
        item = CategoryOut.model_validate(row)
        item.line_count = counts.get(row.id, 0)
        out.append(item)
    return out


@router.post("/categories", response_model=CategoryOut, status_code=status.HTTP_201_CREATED)
def create_category(
    payload: CategoryIn, viewer: CurrentUser, request: Request, db: DbSession
) -> CategoryOut:
    try:
        return CategoryOut.model_validate(
            svc.create_category(db, viewer, payload, request=request)
        )
    except svc.ExpenseError as error:
        _fail(error)


@router.patch("/categories/{category_id}", response_model=CategoryOut)
def update_category(
    category_id: uuid.UUID,
    payload: CategoryUpdate,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> CategoryOut:
    try:
        return CategoryOut.model_validate(
            svc.update_category(db, viewer, category_id, payload, request=request)
        )
    except svc.ExpenseError as error:
        _fail(error)


# --------------------------------------------------------------------------- #
# Queues and summary — declared before /{claim_id} so they are not parsed as ids
# --------------------------------------------------------------------------- #


@router.get("/summary", response_model=SummaryOut)
def summary(
    viewer: CurrentUser, db: DbSession, user_id: uuid.UUID | None = None
) -> SummaryOut:
    return SummaryOut(**svc.summary(db, viewer, user_id=user_id))


@router.get("/review", response_model=list[ClaimOut])
def review_queue(viewer: CurrentUser, db: DbSession) -> list[ClaimOut]:
    """Submitted claims in this approver's reporting subtree."""
    try:
        return _list_out(db, viewer, svc.review_queue(db, viewer))
    except svc.ExpenseError as error:
        _fail(error)


@router.get("/payments", response_model=list[ClaimOut])
def payment_queue(viewer: CurrentUser, db: DbSession) -> list[ClaimOut]:
    """Approved and unpaid. Finance only."""
    try:
        return _list_out(db, viewer, svc.payment_queue(db, viewer))
    except svc.ExpenseError as error:
        _fail(error)


# --------------------------------------------------------------------------- #
# Claims
# --------------------------------------------------------------------------- #


@router.get("", response_model=list[ClaimOut])
def list_claims(
    viewer: CurrentUser,
    db: DbSession,
    mine: bool = False,
    user_id: uuid.UUID | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
) -> list[ClaimOut]:
    return _list_out(
        db, viewer, svc.list_claims(db, viewer, mine=mine, user_id=user_id,
                                    status=status_filter)
    )


@router.post("", response_model=ClaimDetailOut, status_code=status.HTTP_201_CREATED)
def create_claim(
    payload: ClaimIn, viewer: CurrentUser, request: Request, db: DbSession
) -> ClaimDetailOut:
    try:
        return _detail(db, viewer, svc.create_claim(db, viewer, payload, request=request))
    except svc.ExpenseError as error:
        _fail(error)


@router.get("/{claim_id}", response_model=ClaimDetailOut)
def read_claim(claim_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> ClaimDetailOut:
    try:
        return _detail(db, viewer, svc.get_claim(db, viewer, claim_id))
    except svc.ExpenseError as error:
        _fail(error)


@router.patch("/{claim_id}", response_model=ClaimDetailOut)
def update_claim(
    claim_id: uuid.UUID,
    payload: ClaimUpdate,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> ClaimDetailOut:
    try:
        return _detail(
            db, viewer, svc.update_claim(db, viewer, claim_id, payload, request=request)
        )
    except svc.ExpenseError as error:
        _fail(error)


@router.delete("/{claim_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_claim(
    claim_id: uuid.UUID, viewer: CurrentUser, request: Request, db: DbSession
) -> Response:
    """Discard a draft. A submitted claim is cancelled, not deleted — somebody
    reviewed it, and a review of a thing that no longer exists is not a record."""
    try:
        svc.delete_claim(db, viewer, claim_id, request=request)
    except svc.ExpenseError as error:
        _fail(error)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------------- #
# Lines
# --------------------------------------------------------------------------- #


@router.post("/{claim_id}/lines", response_model=ClaimDetailOut,
             status_code=status.HTTP_201_CREATED)
def add_line(
    claim_id: uuid.UUID,
    payload: LineIn,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> ClaimDetailOut:
    """Returns the whole claim, not the line.

    The claim's total changes on every line mutation, and a client that receives
    only the line has to either recompute the total itself — the one thing this
    module refuses to let a client do — or make a second request.
    """
    try:
        svc.add_line(db, viewer, claim_id, payload, request=request)
        return _detail(db, viewer, svc.get_claim(db, viewer, claim_id))
    except svc.ExpenseError as error:
        _fail(error)


@router.patch("/lines/{line_id}", response_model=ClaimDetailOut)
def update_line(
    line_id: uuid.UUID,
    payload: LineUpdate,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> ClaimDetailOut:
    try:
        line = svc.update_line(db, viewer, line_id, payload, request=request)
        return _detail(db, viewer, svc.get_claim(db, viewer, line.claim_id))
    except svc.ExpenseError as error:
        _fail(error)


@router.delete("/lines/{line_id}", response_model=ClaimDetailOut)
def delete_line(
    line_id: uuid.UUID, viewer: CurrentUser, request: Request, db: DbSession
) -> ClaimDetailOut:
    try:
        line = svc.get_line(db, viewer, line_id)
        claim_id = line.claim_id
        svc.delete_line(db, viewer, line_id, request=request)
        return _detail(db, viewer, svc.get_claim(db, viewer, claim_id))
    except svc.ExpenseError as error:
        _fail(error)


@router.post("/lines/{line_id}/receipt", response_model=LineOut)
async def attach_receipt(
    line_id: uuid.UUID,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
    file: UploadFile = File(...),
) -> LineOut:
    """One receipt per line, replacing any previous one.

    No JSON metadata field here, unlike the document uploads: a receipt has no
    attributes of its own — the date, amount and description all live on the
    line it belongs to.
    """
    # One byte past the ceiling, so an oversize upload is refused on its size
    # rather than after the whole thing is buffered.
    raw = await file.read(svc.MAX_RECEIPT_BYTES + 1)
    try:
        line = svc.attach_receipt(
            db, viewer, line_id,
            file_name=file.filename or "",
            content_type=file.content_type or "",
            raw=raw,
            request=request,
        )
    except svc.ExpenseError as error:
        _fail(error)
    category = db.get(ExpenseCategory, line.category_id)
    return _line_out(line, {line.category_id: category})


@router.get("/lines/{line_id}/receipt", response_model=None)
def download_receipt(
    line_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> Response:
    """The only way to read a stored receipt.

    The permission check runs here, on every request — which is exactly what
    putting a ``receipt_key`` in a response body would have thrown away.
    """
    try:
        line, served = svc.serve_receipt(db, viewer, line_id)
    except svc.ExpenseError as error:
        _fail(error)
    if served.url:
        return RedirectResponse(served.url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)
    return FileResponse(
        served.path,
        media_type=line.receipt_type or "application/octet-stream",
        filename=line.receipt_name or None,
    )


# --------------------------------------------------------------------------- #
# Transitions
# --------------------------------------------------------------------------- #


@router.post("/{claim_id}/submit", response_model=ClaimDetailOut)
def submit(
    claim_id: uuid.UUID, viewer: CurrentUser, request: Request, db: DbSession
) -> ClaimDetailOut:
    """Send for approval, and freeze the lines."""
    try:
        return _detail(db, viewer, svc.submit(db, viewer, claim_id, request=request))
    except svc.ExpenseError as error:
        _fail(error)


@router.post("/{claim_id}/review", response_model=ClaimDetailOut)
def review(
    claim_id: uuid.UUID,
    payload: ReviewIn,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> ClaimDetailOut:
    """Approve or reject. One transition, two outcomes."""
    try:
        return _detail(db, viewer, svc.review(db, viewer, claim_id, payload, request=request))
    except svc.ExpenseError as error:
        _fail(error)


@router.post("/{claim_id}/reimburse", response_model=ClaimDetailOut)
def reimburse(
    claim_id: uuid.UUID,
    payload: ReimburseIn,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> ClaimDetailOut:
    """Record that the money has left. Finance only, and only after approval."""
    try:
        return _detail(
            db, viewer, svc.reimburse(db, viewer, claim_id, payload, request=request)
        )
    except svc.ExpenseError as error:
        _fail(error)


@router.post("/{claim_id}/cancel", response_model=ClaimDetailOut)
def cancel(
    claim_id: uuid.UUID, viewer: CurrentUser, request: Request, db: DbSession
) -> ClaimDetailOut:
    """Withdraw a claim before it is decided."""
    try:
        return _detail(db, viewer, svc.cancel(db, viewer, claim_id, request=request))
    except svc.ExpenseError as error:
        _fail(error)
