"""One queue across every approval flow.

Two routes and no verbs. Deciding still happens on the flow's own endpoint, with
the flow's own guards — this is a view, and making it a place where things could
also be approved would put a sixth door on five rooms that already have one.

There is no module gate on this router. A company without the expenses module
gets no expense claims in the queue because it has none, not because a
dependency refused; gating the whole queue on one module would hide leave
requests from a company that never bought expenses.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import CurrentUser, DbSession
from app.schemas.approvals import PendingCountsOut, PendingOut
from app.services import approvals as svc

router = APIRouter(prefix="/approvals", tags=["approvals"])


@router.get("", response_model=list[PendingOut])
def queue(viewer: CurrentUser, db: DbSession) -> list[PendingOut]:
    """Everything awaiting this viewer's decision, oldest first.

    No permission gate here, and that is deliberate rather than an omission:
    each flow's adapter applies that flow's own rule, so an employee who
    approves nothing gets an empty list. A gate here would be a sixth opinion
    about who may approve what.
    """
    return [
        PendingOut(
            kind=item.kind, id=item.id, user_id=item.user_id,
            user_name=item.user_name, title=item.title, detail=item.detail,
            since=item.since, waiting_days=item.waiting_days,
            amount_paise=item.amount_paise,
        )
        for item in svc.pending_for(db, viewer)
    ]


@router.get("/counts", response_model=PendingCountsOut)
def counts(viewer: CurrentUser, db: DbSession) -> PendingCountsOut:
    """How many of each kind are waiting.

    For a navigation badge, so showing one does not mean building and throwing
    away the whole queue on every page load.
    """
    return PendingCountsOut(**svc.counts_for(db, viewer))
