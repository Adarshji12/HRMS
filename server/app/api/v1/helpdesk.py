"""Helpdesk: categories, tickets and the two-audience comment thread.

The routing table is the security boundary made visible. Everything an
employee may reach lives under ``/helpdesk/tickets``; the whole staff surface
lives under ``/helpdesk/staff/...`` behind one dependency. Splitting them by
URL rather than by an ``if`` inside a shared handler is deliberate: a response
model is declared per route, so the employee-facing routes are statically
incapable of returning ``StaffCommentOut`` or a comment count, and adding a
staff field to one of them is a change a reviewer sees in the diff.

**The staff surface has a second boundary inside it (D-026).** Reaching
``/helpdesk/staff/...`` means you may work the queue. It does not mean you may
read HR's internal notes -- that takes ``can_administer`` or being the ticket's
assignee, and it is decided in one place,
``helpdesk.may_read_internal_notes``. The routes that echo a ticket back
therefore declare ``response_model=None`` and let the service choose between
the entitled and redacted shapes; ``helpdesk.detail_for`` explains why a union
``response_model`` would be worse than none at all. A non-entitled staff
caller is never refused here -- they get the redacted shape, because a 403
would itself confirm that notes exist to be refused.

The handlers are thin on purpose — every rule lives in
``app.services.helpdesk``. A router function here that grows a business rule
is a review failure, and in this module it is also how an internal note
eventually gets published.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, status
from pydantic import BaseModel

from app.api.deps import (
    CurrentUser,
    DbSession,
    TeamViewer,
    audit,
    deny_unless,
)
from app.models import TicketStatus, User
from app.schemas.helpdesk import (
    CategoryIn,
    CategoryOut,
    CommentIn,
    PublicCommentOut,
    StaffCommentIn,
    StaffCommentOut,
    TicketDetailOut,
    TicketIn,
    TicketOut,
    TicketStaffDetailOut,
    TicketStaffOut,
    TicketUpdateIn,
)
from app.services import helpdesk as hd

router = APIRouter(prefix="/helpdesk", tags=["helpdesk"])


def require_helpdesk_staff(user: TeamViewer) -> User:
    """Sees other people's tickets AND may work them.

    Composed exactly like ``require_approver``: the role check runs first
    (``TeamViewer``), then the per-person flag restricts. That order is the
    whole permission model — ``can_manage_helpdesk`` may only ever take access
    away, so an employee with the flag left on gains nothing.

    Must agree with ``helpdesk.is_helpdesk_staff``, which the service uses to
    decide who may be *assigned* a ticket. If one changes, change both.
    """
    deny_unless(user, "can_manage_helpdesk", "manage helpdesk tickets")
    return user


HelpdeskStaff = Annotated[User, Depends(require_helpdesk_staff)]


class AssignIn(BaseModel):
    """``None`` unassigns. Explicit, because "leave unchanged" is not an option here."""

    assignee_id: uuid.UUID | None = None


class SourceLinkOut(BaseModel):
    """The rendered back-link.

    Deliberately carries no reason: unavailable is unavailable, whether the row
    was deleted, belongs to another tenant, sits in a module this deployment
    does not run, or is simply none of the caller's business. Distinguishing
    them is what turns the link into an existence oracle — see D-019 and
    ``helpdesk.resolve_source``.
    """

    module: str | None = None
    ref: uuid.UUID | None = None
    available: bool = False
    label: str | None = None


# --------------------------------------------------------------------------- #
# Categories
# --------------------------------------------------------------------------- #


@router.get("/categories", response_model=list[CategoryOut])
def list_categories(
    viewer: CurrentUser, db: DbSession, include_inactive: bool = False
) -> list[CategoryOut]:
    """Readable by everyone — an employee needs the names to file a ticket.

    The counts on the response are filled by the service for staff only; see
    ``helpdesk.list_categories``.
    """
    return hd.list_categories(db, viewer, include_inactive=include_inactive)


@router.post("/categories", response_model=CategoryOut, status_code=status.HTTP_201_CREATED)
def create_category(
    payload: CategoryIn, staff: HelpdeskStaff, request: Request, db: DbSession
) -> CategoryOut:
    category = hd.create_category(db, staff.org_id, payload)
    audit(db, org_id=staff.org_id, actor=staff, action="helpdesk.category.created",
          request=request, target_type="helpdesk_category", target_id=str(category.id))
    db.commit()
    return CategoryOut(
        id=category.id,
        name=category.name,
        description=category.description,
        default_assignee_role=category.default_assignee_role,
        is_active=category.is_active,
    )


@router.patch("/categories/{category_id}", response_model=CategoryOut)
def update_category(
    category_id: uuid.UUID, payload: CategoryIn, staff: HelpdeskStaff, db: DbSession
) -> CategoryOut:
    category = hd.get_category(db, staff.org_id, category_id)
    hd.update_category(db, category, payload)
    db.commit()
    return CategoryOut(
        id=category.id,
        name=category.name,
        description=category.description,
        default_assignee_role=category.default_assignee_role,
        is_active=category.is_active,
    )


@router.delete(
    "/categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None
)
def delete_category(category_id: uuid.UUID, staff: HelpdeskStaff, db: DbSession) -> None:
    category = hd.get_category(db, staff.org_id, category_id)
    hd.delete_category(db, category)
    db.commit()


# --------------------------------------------------------------------------- #
# Tickets — the employee's own
# --------------------------------------------------------------------------- #


@router.post("/tickets", response_model=TicketOut, status_code=status.HTTP_201_CREATED)
def raise_ticket(payload: TicketIn, viewer: CurrentUser, db: DbSession) -> TicketOut:
    """Anyone may raise a ticket about themselves. No permission flag gates this.

    ``TicketIn`` has no ``status`` or ``assigned_to``: a raiser does not get to
    open a ticket pre-resolved or pre-assigned.
    """
    ticket = hd.raise_ticket(db, viewer, payload)
    return hd.ticket_out(db, ticket)


@router.get("/tickets", response_model=list[TicketOut])
def list_my_tickets(
    viewer: CurrentUser,
    db: DbSession,
    status_filter: str | None = Query(default=None, alias="status"),
    open_only: bool = False,
) -> list[TicketOut]:
    """Only the caller's own tickets, and never with a comment count.

    ``TicketOut`` carries no count field at all, so this route cannot grow one
    by accident.
    """
    return hd.list_my_tickets(db, viewer, status_filter=status_filter, open_only=open_only)


@router.get("/tickets/{ticket_id}", response_model=TicketDetailOut)
def get_my_ticket(ticket_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> TicketDetailOut:
    """The raiser's own ticket, with only the comments they may read.

    Someone else's ticket is a 404 rather than a 403 — a 403 confirms that a
    ticket with that id exists here, which is the first half of a grievance.
    That applies to staff too: this route answers for the raiser and nobody
    else, so a staff user reading a colleague's ticket has to do it through
    ``/helpdesk/staff/tickets/{id}``, where the flag is checked and the
    response type says out loud that it may contain internal notes.
    """
    ticket = hd.get_ticket(db, viewer.org_id, ticket_id)
    hd.require_raiser(ticket, viewer)
    return hd.redacted_detail(db, ticket)


@router.get("/tickets/{ticket_id}/source", response_model=SourceLinkOut)
def get_my_ticket_source(
    ticket_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> SourceLinkOut:
    """Resolve the back-link, for this caller, right now.

    Resolved against the viewer rather than stored at write time because the
    ref is a pointer and not a grant: the target module authorises the click,
    and a person who has since moved teams must stop seeing the label.
    """
    ticket = hd.get_ticket(db, viewer.org_id, ticket_id)
    hd.require_raiser(ticket, viewer)
    link = hd.resolve_source(db, viewer, ticket.source_module, ticket.source_ref)
    return SourceLinkOut(**vars(link))


@router.post(
    "/tickets/{ticket_id}/comments",
    response_model=PublicCommentOut,
    status_code=status.HTTP_201_CREATED,
)
def add_my_comment(
    ticket_id: uuid.UUID, payload: CommentIn, viewer: CurrentUser, db: DbSession
) -> PublicCommentOut:
    """The employee replying on their own ticket.

    ``CommentIn`` has no ``is_internal`` and forbids extras, and the literal
    ``False`` below is the only value this path can produce. Two independent
    reasons an employee cannot author an internal note, because one of them
    being wrong should not be enough.
    """
    ticket = hd.get_ticket(db, viewer.org_id, ticket_id)
    hd.require_raiser(ticket, viewer)
    hd.can_comment(ticket)
    comment = hd.add_comment(db, ticket, viewer, payload.body, is_internal=False)
    return hd.public_comment(db, ticket, comment)


@router.post("/tickets/{ticket_id}/reopen", response_model=TicketOut)
def reopen_my_ticket(ticket_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> TicketOut:
    """The raiser rejecting a fix. ``resolved`` is not terminal; ``closed`` is."""
    ticket = hd.get_ticket(db, viewer.org_id, ticket_id)
    hd.require_raiser(ticket, viewer)
    hd.employee_reopen(db, viewer, ticket)
    return hd.ticket_out(db, ticket)


@router.post("/tickets/{ticket_id}/close", response_model=TicketOut)
def close_my_ticket(ticket_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> TicketOut:
    """The raiser withdrawing their own ticket — closed without ever being resolved."""
    ticket = hd.get_ticket(db, viewer.org_id, ticket_id)
    hd.require_raiser(ticket, viewer)
    hd.employee_close(db, viewer, ticket)
    return hd.ticket_out(db, ticket)


# --------------------------------------------------------------------------- #
# Tickets — the staff queue
#
# Everything below this line can see internal notes. That is why it is a
# separate URL prefix behind a single dependency rather than a branch inside
# the handlers above.
# --------------------------------------------------------------------------- #


@router.get("/staff/tickets", response_model=None)
def list_queue(
    staff: HelpdeskStaff,
    db: DbSession,
    status_filter: str | None = Query(default=None, alias="status"),
    assigned_to: uuid.UUID | None = None,
    mine_only: bool = False,
    unassigned_only: bool = False,
    category_id: uuid.UUID | None = None,
    open_only: bool = True,
) -> list[TicketStaffOut | TicketOut]:
    """The queue. Rows the caller may not read notes on come back without counts.

    A mixed list, on purpose -- see ``helpdesk.list_queue``. Zeroing the counts
    instead would assert "no internal notes" on a ticket that has eight.
    """
    return hd.list_queue(
        db,
        staff,
        status_filter=status_filter,
        assigned_to=assigned_to,
        mine_only=mine_only,
        unassigned_only=unassigned_only,
        category_id=category_id,
        open_only=open_only,
    )


@router.get("/staff/tickets/{ticket_id}", response_model=None)
def get_ticket_for_staff(
    ticket_id: uuid.UUID, staff: HelpdeskStaff, db: DbSession
) -> TicketStaffDetailOut | TicketDetailOut:
    """Ticket detail, in whichever shape D-026 entitles this caller to.

    An administrator or the assignee gets the thread including internal notes
    and both counts. Any other staff member gets the redacted shape -- the
    public thread, and no key that would reveal a note exists. Not a 403:
    refusing would confirm there is something to refuse, and a manager
    triaging the queue has a legitimate reason to read the public thread.
    """
    return hd.detail_for(db, staff, hd.get_ticket(db, staff.org_id, ticket_id))


@router.get("/staff/tickets/{ticket_id}/source", response_model=SourceLinkOut)
def get_ticket_source_for_staff(
    ticket_id: uuid.UUID, staff: HelpdeskStaff, db: DbSession
) -> SourceLinkOut:
    ticket = hd.get_ticket(db, staff.org_id, ticket_id)
    link = hd.resolve_source(db, staff, ticket.source_module, ticket.source_ref)
    return SourceLinkOut(**vars(link))


@router.patch("/staff/tickets/{ticket_id}", response_model=None)
def update_ticket(
    ticket_id: uuid.UUID,
    payload: TicketUpdateIn,
    staff: HelpdeskStaff,
    request: Request,
    db: DbSession,
) -> TicketStaffOut | TicketOut:
    """Status, priority, category and assignee. Timestamps are the service's.

    ``resolved_at`` / ``closed_at`` are not on ``TicketUpdateIn`` at all: a
    timestamp a client can set independently of the status it describes will
    eventually disagree with it, and then every SLA report is wrong.
    """
    ticket = hd.get_ticket(db, staff.org_id, ticket_id)
    before = ticket.status
    hd.update_ticket(db, staff, ticket, payload)
    if ticket.status != before:
        audit(db, org_id=staff.org_id, actor=staff, action="helpdesk.ticket.status",
              request=request, target_type="helpdesk_ticket", target_id=str(ticket.id),
              detail={"from": before, "to": ticket.status})
        db.commit()
    return hd.row_for(db, staff, ticket)


@router.post("/staff/tickets/{ticket_id}/assign", response_model=None)
def assign_ticket(
    ticket_id: uuid.UUID,
    payload: AssignIn,
    staff: HelpdeskStaff,
    request: Request,
    db: DbSession,
) -> TicketStaffOut | TicketOut:
    """Assign or unassign. The target must itself be helpdesk staff.

    That check lives in the service and is an access decision, not a workflow
    one: being the assignee is how a person starts reading a ticket's internal
    notes.
    """
    ticket = hd.get_ticket(db, staff.org_id, ticket_id)
    hd.assign(db, staff, ticket, payload.assignee_id)
    audit(db, org_id=staff.org_id, actor=staff, action="helpdesk.ticket.assigned",
          request=request, target_type="helpdesk_ticket", target_id=str(ticket.id),
          detail={"assignee_id": payload.assignee_id})
    db.commit()
    return hd.row_for(db, staff, ticket)


@router.post("/staff/tickets/{ticket_id}/resolve", response_model=None)
def resolve_ticket(
    ticket_id: uuid.UUID, staff: HelpdeskStaff, db: DbSession
) -> TicketStaffOut | TicketOut:
    ticket = hd.get_ticket(db, staff.org_id, ticket_id)
    hd.set_status(db, staff, ticket, TicketStatus.RESOLVED.value)
    return hd.row_for(db, staff, ticket)


@router.post("/staff/tickets/{ticket_id}/close", response_model=None)
def close_ticket(
    ticket_id: uuid.UUID, staff: HelpdeskStaff, db: DbSession
) -> TicketStaffOut | TicketOut:
    ticket = hd.get_ticket(db, staff.org_id, ticket_id)
    hd.set_status(db, staff, ticket, TicketStatus.CLOSED.value)
    return hd.row_for(db, staff, ticket)


@router.post("/staff/tickets/{ticket_id}/reopen", response_model=None)
def reopen_ticket(
    ticket_id: uuid.UUID, staff: HelpdeskStaff, db: DbSession
) -> TicketStaffOut | TicketOut:
    """Reopening clears ``resolved_at`` as well as ``closed_at`` — see ``_apply_status``."""
    ticket = hd.get_ticket(db, staff.org_id, ticket_id)
    hd.reopen(db, staff, ticket)
    return hd.row_for(db, staff, ticket)


@router.post(
    "/staff/tickets/{ticket_id}/comments",
    response_model=StaffCommentOut,
    status_code=status.HTTP_201_CREATED,
)
def add_staff_comment(
    ticket_id: uuid.UUID, payload: StaffCommentIn, staff: HelpdeskStaff, db: DbSession
) -> StaffCommentOut:
    """A staff reply or an internal note. ``is_internal`` is required in the body.

    No default, on purpose: defaulting to False leaks the note the one time an
    HR user forgets the toggle, and defaulting to True hides answers the
    employee was waiting for. Making the caller say it every time is the only
    version that cannot fail silently.

    ``is_internal=True`` additionally needs the D-026 right — an administrator,
    or this ticket's assignee. A public reply needs only the staff gate, so a
    manager triaging the queue can still answer the employee. Refusing the
    write here is safe in a way refusing the *read* would not be: the caller
    already knows what they tried to write, so the 403 tells them nothing about
    what is on the ticket.
    """
    ticket = hd.get_ticket(db, staff.org_id, ticket_id)
    if payload.is_internal:
        hd.require_internal_note_right(staff, ticket)
    # Deliberately no closed-ticket guard here, unlike the employee path. An
    # internal note recording why a ticket was closed as a duplicate — or what
    # was agreed afterwards — is written after the fact by definition, and the
    # thread is HR's own record. The employee is stopped instead, because for
    # them a closed ticket is a conversation nobody is watching any more.
    comment = hd.add_comment(db, ticket, staff, payload.body, is_internal=payload.is_internal)
    return hd.staff_comment(db, ticket, comment)
