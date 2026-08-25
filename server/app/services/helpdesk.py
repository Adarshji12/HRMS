"""Helpdesk ticket lifecycle, assignment routing, and the visibility split.

This service owns everything the router is not allowed to know: who counts as
helpdesk staff, which comments an audience may read, when the two timestamps
get stamped, and how a ticket's back-link to another module is resolved without
helpdesk depending on that module.

**The one thing a reader must not get wrong.** ``HelpdeskComment.is_internal``
is a security boundary. Nothing in this file hands a comment row to a caller;
every read path goes through the audience-typed schemas in
``app.schemas.helpdesk``, where ``PublicCommentOut.is_internal`` is pinned to
``Literal[False]`` so an internal row cannot validate into an employee-facing
response. Picking the wrong builder here is a 500, never a disclosure — which
is the whole reason the schemas are shaped that way. Do not add a code path
that serialises a comment by hand.

The counts are part of the same boundary and are handled the same way. Only the
entitled shapes carry ``comment_count`` / ``internal_comment_count``, because
telling someone a ticket has twelve comments when they can read four tells them
eight notes exist. See ``redacted_detail`` and ``internal_detail``: they are
siblings, deliberately, so no amount of refactoring can make one fall through
to the other.

**Who the boundary runs between (D-026).** Not "employee versus staff" -- that
was the original design and it was wrong. ``can_manage_helpdesk`` defaults to
True and staff resolves to every team-viewing role, so the first version of
this module let every manager in the company read every internal note on every
ticket, including a grievance filed about that manager. The schema split was
airtight against the employee and wide open to the peer manager.

So the right to read an internal note is its own right, decided by
``may_read_internal_notes`` and nothing else:

* ``can_administer`` -- owner or admin. HR, who the notes belong to.
* or being the ticket's **assignee**. Taking a ticket is the act that claims
  it, and it is visible on every staff shape, so who holds the right is on the
  screen rather than in a config table.

Everything else staff can do -- see the queue, triage, assign, set priority,
reply publicly, resolve, close -- is unchanged and still gated on
``TeamViewer`` + ``can_manage_helpdesk``. Writing an internal note takes the
same right as reading one, because a note its author cannot read back is not a
useful thing to be able to write.

Three read paths carry the counts and therefore all three consult that
predicate: ``detail_for`` (a ticket), ``list_queue`` (per row, so one page can
legitimately be a mix of shapes) and ``row_for`` (every staff *write* echoes
the ticket back, which makes each mutation a read path too -- the leak that
comes back through the door marked "write" if you only guard the GETs).

**Provenance (D-019).** ``source_module`` / ``source_ref`` is not a foreign key
and never will be — the model docstring explains why. The consequence this file
owns is that both halves of the link are hostile input:

* At write time the referenced row is verified against the raiser's own
  visibility *before* it is stored. Skipping that turns the field into an
  existence oracle: post one ticket per guessed UUID, read back the rendered
  link, and learn which ids exist in a module you cannot otherwise see.
* At read time an unknown ``source_module`` and a deleted, purged or
  unauthorised row all resolve to the same unavailable link. They must be
  indistinguishable to the caller, because "you may not see this" and "this
  does not exist" are the two answers an oracle needs to tell apart.
* The dispatch is a ``dict.get``, never ``dict[...]``. A ``KeyError`` on an
  unknown module string would turn a perfectly valid ticket into a 500 the
  first time a module is renamed or a bulk import writes a stale name.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import visible_user_ids
from app.models import (
    AssetAssignment,
    AttendanceRecord,
    HelpdeskCategory,
    HelpdeskComment,
    HelpdeskTicket,
    LeaveApplication,
    OffboardingRequest,
    OnboardingInstance,
    RegularizationRequest,
    TicketStatus,
    User,
)
from app.schemas.helpdesk import (
    CategoryIn,
    CategoryOut,
    PublicCommentOut,
    StaffCommentOut,
    TicketDetailOut,
    TicketIn,
    TicketOut,
    TicketStaffDetailOut,
    TicketStaffOut,
    TicketUpdateIn,
)
from app.services import notifications as notif


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# Who may work the helpdesk
# --------------------------------------------------------------------------- #


def is_helpdesk_staff(user: User) -> bool:
    """The predicate behind the router's ``require_helpdesk_staff`` dependency.

    Two conditions, in the order the permission model demands: the **role**
    already lets this person see other employees' data, **and** the per-person
    flag has not been switched off. The flags restrict and never grant (see the
    note on the columns in ``app.models.user``), so the role check has to come
    first — otherwise ticking ``can_manage_helpdesk`` on an ordinary employee
    would hand them every grievance filed in the company.

    ``can_view_team`` rather than ``can_administer`` because
    ``HelpdeskCategory.default_assignee_role`` accepts ``manager``: a category
    routed to managers whose managers could never open a ticket would be a
    routing hint pointing at nobody.

    This must agree with ``require_helpdesk_staff`` in the router. It is
    duplicated rather than shared only because the dependency needs
    ``deny_unless`` to produce the standard ``permission_denied`` payload; if
    one changes, change both.
    """
    return bool(user.is_active and user.role_enum.can_view_team and user.can_manage_helpdesk)


def may_read_internal_notes(user: User, ticket: HelpdeskTicket) -> bool:
    """D-026. Working the helpdesk is not the same right as reading its notes.

    Being staff means you can see the queue, triage it, assign it, reply to the
    employee and resolve it. It does **not** mean you can read HR's private
    notes about a colleague. Those two were the same right until D-026, and the
    case that proves they cannot be is the ordinary one: a grievance filed
    *about* a manager, sitting in a queue that manager can open.

    So internal notes need one of two things, and neither is "is staff":

    * ``can_administer`` -- owner or admin, which in this product is HR. The
      people the notes are written by and for.
    * being the **assigned** staff member. Someone has to be able to work a
      ticket without being an admin, and taking the ticket is the act that says
      "this one is mine". It is also visible: ``assigned_to`` is on every
      staff-facing shape, so who acquired the right is on the screen rather
      than in a config table.

    ``is_helpdesk_staff`` still has to hold. It is re-checked here rather than
    assumed from the router's dependency because this predicate decides
    disclosure, and a disclosure check that relies on its caller having run a
    different check is one refactor away from being no check at all.

    Fails closed on an unassigned ticket: ``assigned_to`` is NULL, NULL matches
    nobody, and an untaken ticket is therefore admin-only. That is the right
    default -- an unassigned grievance is precisely the one nobody has claimed
    responsibility for yet.
    """
    if not is_helpdesk_staff(user):
        return False
    if user.role_enum.can_administer:
        return True
    return ticket.assigned_to is not None and ticket.assigned_to == user.id


def require_internal_note_right(user: User, ticket: HelpdeskTicket) -> None:
    """The write half of D-026: you may only author what you could read back.

    A note its own author cannot retrieve is not a useful thing to be able to
    write, and allowing it would create the worst version of this feature --
    private notes accumulating on a ticket, authored by people who cannot see
    the thread they are contributing to.

    Refused with the same ``permission_denied`` payload ``deny_unless``
    produces, so the console renders one message for every permission refusal
    in the product rather than a special case for this one.
    """
    if not may_read_internal_notes(user, ticket):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={
                "reason": "permission_denied",
                "message": (
                    "Your account is not permitted to read or write internal notes "
                    "on this ticket. Assign it to yourself first, or ask an "
                    "administrator."
                ),
            },
        )


# --------------------------------------------------------------------------- #
# Source links — D-019
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class SourceLink:
    """The resolved form of a ticket's back-link, for one viewer.

    ``available`` is False for every failure — no module, unknown module, row
    deleted, row in another tenant, viewer not permitted — and ``label`` is
    None whenever it is. There is deliberately no reason code: a caller able to
    tell "denied" from "gone" can enumerate ids by posting tickets.
    """

    module: str | None
    ref: uuid.UUID | None
    available: bool
    label: str | None = None


def _reg_label(row: RegularizationRequest) -> str:
    return f"Attendance correction for {row.date.isoformat()}"


def _attendance_label(row: AttendanceRecord) -> str:
    return f"Attendance record for {row.date.isoformat()}"


def _leave_label(row: LeaveApplication) -> str:
    if row.start_date == row.end_date:
        return f"Leave on {row.start_date.isoformat()}"
    return f"Leave from {row.start_date.isoformat()} to {row.end_date.isoformat()}"


def _asset_label(row: AssetAssignment) -> str:
    # getattr through the relationship: the asset row is the target of a real
    # FK here, but this label is rendered on a page that must never 500, so a
    # half-loaded row degrades to the generic wording rather than raising.
    tag = getattr(getattr(row, "asset", None), "asset_tag", None)
    when = row.assigned_at.date().isoformat() if row.assigned_at else "an earlier date"
    return f"Asset {tag} assigned on {when}" if tag else f"Asset assignment from {when}"


def _onboarding_label(row: OnboardingInstance) -> str:
    return f"Onboarding starting {row.joining_date.isoformat()}"


def _offboarding_label(row: OffboardingRequest) -> str:
    return f"Exit process from {row.notice_date.isoformat()}"


@dataclass(frozen=True)
class _SourceSpec:
    model: type
    label: Callable[[object], str]


#: Every module a ticket may legitimately be raised from.
#:
#: The entries share a shape rather than a base class: each target table has
#: ``org_id`` and ``user_id``, which is all the visibility check needs. That is
#: a property of the tables, checked here at import time by the loop below, not
#: an assumption — a module whose rows are not owned by one employee cannot use
#: this registry and would need its own answer to "may this person see it".
#:
#: Adding a module here is the ONLY registration needed, and removing one is
#: safe: existing tickets naming it simply resolve to unavailable.
SOURCE_MODULES: dict[str, _SourceSpec] = {
    "regularization": _SourceSpec(RegularizationRequest, _reg_label),
    "attendance": _SourceSpec(AttendanceRecord, _attendance_label),
    "leave": _SourceSpec(LeaveApplication, _leave_label),
    "assets": _SourceSpec(AssetAssignment, _asset_label),
    "onboarding": _SourceSpec(OnboardingInstance, _onboarding_label),
    "offboarding": _SourceSpec(OffboardingRequest, _offboarding_label),
}

for _name, _spec in SOURCE_MODULES.items():
    # Fails at import, not on the first ticket raised from a mistyped module.
    assert hasattr(_spec.model, "org_id") and hasattr(_spec.model, "user_id"), (
        f"source module {_name!r} points at a table without org_id/user_id; "
        f"the visibility check in _visible_source_row cannot be applied to it"
    )
del _name, _spec


def _visible_source_row(
    db: Session, viewer: User, module: str | None, ref: uuid.UUID | None
) -> tuple[_SourceSpec, object] | None:
    """The referenced row, if this viewer is allowed to know it exists.

    One function for both the write-time check and the read-time render, so the
    two can never drift into disagreeing about what is visible — which would be
    the oracle back again, one release later.
    """
    if module is None or ref is None:
        return None
    spec = SOURCE_MODULES.get(module)
    if spec is None:
        # Unknown module: a renamed module, a bulk import, a deployment without
        # that feature. Not an error, and never a KeyError.
        return None

    row = db.get(spec.model, ref)
    if row is None or getattr(row, "org_id", None) != viewer.org_id:
        return None

    allowed = visible_user_ids(db, viewer)
    # None means "the whole organisation" — an admin needs no further filter.
    if allowed is not None and getattr(row, "user_id", None) not in set(allowed):
        return None
    return spec, row


def resolve_source(
    db: Session, viewer: User, module: str | None, ref: uuid.UUID | None
) -> SourceLink:
    """Render a ticket's back-link for one viewer. Never raises, never 500s.

    Resolved against the *viewer*, not the raiser: the ref is a pointer, not a
    grant, so the target module authorises every click on its own. A staff user
    who may see the linked row gets the label; the raiser who has since moved
    teams stops getting it, which is correct.
    """
    found = _visible_source_row(db, viewer, module, ref)
    if found is None:
        return SourceLink(module=module, ref=ref, available=False, label=None)
    spec, row = found
    try:
        label = spec.label(row)
    except Exception:  # noqa: BLE001
        # A label is decoration. A ticket detail page that 500s because some
        # other module left a NULL in a column this formatter assumed is not.
        return SourceLink(module=module, ref=ref, available=False, label=None)
    return SourceLink(module=module, ref=ref, available=True, label=label)


def verify_source(db: Session, raiser: User, payload: TicketIn) -> None:
    """Refuse to *store* a ref the raiser cannot already see.

    The link a caller cannot open would render as unavailable anyway, so this
    is not about the link. It is about the write itself: an unchecked write
    lets anyone probe for the existence of ids in modules they have no access
    to, one ticket per guess, reading the answer off the rendered link. Cheap
    here; impossible to retrofit once tickets carry unvetted refs.

    Both failures return the same message on purpose. "Unknown module" is safe
    to name — it is a constant the client already knows and carries no id — but
    "that row is not yours" and "that row does not exist" must not be
    distinguishable, so they share one response.
    """
    if payload.source_module is None or payload.source_ref is None:
        return
    if _visible_source_row(db, raiser, payload.source_module, payload.source_ref) is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "reason": "source_not_verifiable",
                "message": "The linked item could not be verified.",
            },
        )


# --------------------------------------------------------------------------- #
# Shared read helpers
# --------------------------------------------------------------------------- #


def _names(db: Session, org_id: uuid.UUID) -> dict[uuid.UUID, tuple[str, str]]:
    """(full_name, role) per user, one query — the projects.py precedent.

    An organisation's user table is hundreds of rows, and the alternative is a
    join per derived display field on every list endpoint.
    """
    return {
        row[0]: (row[1], row[2])
        for row in db.execute(select(User.id, User.full_name, User.role).where(User.org_id == org_id))
    }


def _category_names(db: Session, org_id: uuid.UUID) -> dict[uuid.UUID, str]:
    return {
        row[0]: row[1]
        for row in db.execute(
            select(HelpdeskCategory.id, HelpdeskCategory.name).where(
                HelpdeskCategory.org_id == org_id
            )
        )
    }


def _base_fields(
    ticket: HelpdeskTicket,
    names: dict[uuid.UUID, tuple[str, str]],
    categories: dict[uuid.UUID, str],
) -> dict:
    """The fields shared by every ticket shape, employee-facing and staff.

    Nothing derived from comments belongs in here. Anything added to this dict
    is visible to the employee who raised the ticket.
    """
    raiser = names.get(ticket.raised_by) if ticket.raised_by else None
    assignee = names.get(ticket.assigned_to) if ticket.assigned_to else None
    return {
        "id": ticket.id,
        "subject": ticket.subject,
        "description": ticket.description,
        "status": ticket.status,
        "priority": ticket.priority,
        "category_id": ticket.category_id,
        "raised_by": ticket.raised_by,
        "assigned_to": ticket.assigned_to,
        "created_at": ticket.created_at,
        "resolved_at": ticket.resolved_at,
        "closed_at": ticket.closed_at,
        "source_module": ticket.source_module,
        "source_ref": ticket.source_ref,
        "category_name": categories.get(ticket.category_id) if ticket.category_id else None,
        "raised_by_name": raiser[0] if raiser else None,
        "assigned_to_name": assignee[0] if assignee else None,
    }


@dataclass(frozen=True)
class _CommentRow:
    """A comment plus its resolved author, before it meets an audience schema.

    Deliberately carries ``is_internal``: ``PublicCommentOut.from_visible``
    filters on that attribute and defaults to *internal* when it is missing, so
    handing it rows that dropped the flag would silently publish notes with the
    incriminating field stripped off. Keeping the flag all the way to the
    schema boundary is what makes the boundary work.
    """

    id: uuid.UUID
    ticket_id: uuid.UUID
    author_id: uuid.UUID | None
    body: str
    created_at: datetime
    is_internal: bool
    author_name: str | None
    author_role: str | None


def _comment_rows(
    ticket: HelpdeskTicket, names: dict[uuid.UUID, tuple[str, str]]
) -> list[_CommentRow]:
    """Every comment on the ticket, internal ones included, in thread order.

    This is the only place internal notes and replies travel together, and it
    is not a response shape — the audience schemas below are what decide who
    sees what. Filtering here instead would move the security decision into a
    helper whose name does not mention it.
    """
    rows = []
    for comment in ticket.comments:
        author = names.get(comment.author_id) if comment.author_id else None
        rows.append(
            _CommentRow(
                id=comment.id,
                ticket_id=comment.ticket_id,
                author_id=comment.author_id,
                body=comment.body,
                created_at=comment.created_at,
                is_internal=bool(comment.is_internal),
                author_name=author[0] if author else None,
                author_role=author[1] if author else None,
            )
        )
    return rows


# --------------------------------------------------------------------------- #
# Categories
# --------------------------------------------------------------------------- #


def list_categories(
    db: Session, viewer: User, *, include_inactive: bool = False
) -> list[CategoryOut]:
    """The category list. Counts are filled for staff only.

    An employee needs the names to file a ticket; they do not need to be told
    that Grievance has fourteen open tickets in it this month. The counts
    default to 0 on ``CategoryOut``, so withholding them costs nothing at the
    edge and is one fewer aggregate leaking out of a shared shape.
    """
    stmt = (
        select(HelpdeskCategory)
        .where(HelpdeskCategory.org_id == viewer.org_id)
        .order_by(HelpdeskCategory.name)
    )
    if not include_inactive:
        stmt = stmt.where(HelpdeskCategory.is_active.is_(True))
    categories = list(db.scalars(stmt).all())

    if not is_helpdesk_staff(viewer):
        return [
            CategoryOut(
                id=c.id,
                name=c.name,
                description=c.description,
                default_assignee_role=c.default_assignee_role,
                is_active=c.is_active,
            )
            for c in categories
        ]

    open_states = [TicketStatus.OPEN.value, TicketStatus.IN_PROGRESS.value]
    totals: dict[uuid.UUID, int] = {}
    opens: dict[uuid.UUID, int] = {}
    for row in db.execute(
        select(HelpdeskTicket.category_id, HelpdeskTicket.status, func.count(HelpdeskTicket.id))
        .where(HelpdeskTicket.org_id == viewer.org_id, HelpdeskTicket.category_id.is_not(None))
        .group_by(HelpdeskTicket.category_id, HelpdeskTicket.status)
    ):
        totals[row[0]] = totals.get(row[0], 0) + int(row[2])
        if row[1] in open_states:
            opens[row[0]] = opens.get(row[0], 0) + int(row[2])

    return [
        CategoryOut(
            id=c.id,
            name=c.name,
            description=c.description,
            default_assignee_role=c.default_assignee_role,
            is_active=c.is_active,
            ticket_count=totals.get(c.id, 0),
            open_ticket_count=opens.get(c.id, 0),
        )
        for c in categories
    ]


def get_category(db: Session, org_id: uuid.UUID, category_id: uuid.UUID) -> HelpdeskCategory:
    category = db.get(HelpdeskCategory, category_id)
    if category is None or category.org_id != org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Category not found")
    return category


def create_category(db: Session, org_id: uuid.UUID, payload: CategoryIn) -> HelpdeskCategory:
    name = payload.name.strip()
    clash = db.scalar(
        select(HelpdeskCategory.id).where(
            HelpdeskCategory.org_id == org_id, HelpdeskCategory.name == name
        )
    )
    if clash is not None:
        # Checked rather than letting uq_helpdesk_categories_org_name fire,
        # so the caller gets a sentence instead of a constraint name in a 500.
        raise HTTPException(status.HTTP_409_CONFLICT, "A category with that name exists")
    category = HelpdeskCategory(
        org_id=org_id,
        name=name,
        description=payload.description,
        default_assignee_role=payload.default_assignee_role,
        is_active=payload.is_active,
    )
    db.add(category)
    db.flush()
    return category


def update_category(
    db: Session, category: HelpdeskCategory, payload: CategoryIn
) -> HelpdeskCategory:
    name = payload.name.strip()
    if name != category.name:
        clash = db.scalar(
            select(HelpdeskCategory.id).where(
                HelpdeskCategory.org_id == category.org_id,
                HelpdeskCategory.name == name,
                HelpdeskCategory.id != category.id,
            )
        )
        if clash is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, "A category with that name exists")
    category.name = name
    category.description = payload.description
    category.default_assignee_role = payload.default_assignee_role
    category.is_active = payload.is_active
    db.flush()
    return category


def delete_category(db: Session, category: HelpdeskCategory) -> None:
    """Hard delete only while nothing has been filed under it.

    The FK is ON DELETE SET NULL, so deleting a used category would not fail —
    it would quietly erase what a year of tickets were about. Same trade as
    ``delete_project``: refuse, and point at the soft delete that exists for
    exactly this.
    """
    used = db.scalar(
        select(func.count(HelpdeskTicket.id)).where(HelpdeskTicket.category_id == category.id)
    )
    if used:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "reason": "category_in_use",
                "message": (
                    f"{used} tickets were filed under this category. Deactivate it "
                    f"instead so their history keeps saying what they were about."
                ),
            },
        )
    db.delete(category)
    db.flush()


# --------------------------------------------------------------------------- #
# Tickets — reads
# --------------------------------------------------------------------------- #


def get_ticket(db: Session, org_id: uuid.UUID, ticket_id: uuid.UUID) -> HelpdeskTicket:
    ticket = db.get(HelpdeskTicket, ticket_id)
    if ticket is None or ticket.org_id != org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ticket not found")
    return ticket


def require_raiser(ticket: HelpdeskTicket, viewer: User) -> None:
    """404, not 403, when this is somebody else's ticket.

    403 would confirm that a ticket with that id exists in this organisation,
    which is the first half of a grievance nobody outside HR should learn about.
    ``raised_by`` is nullable and NULL matches nobody, so an orphaned ticket
    becomes staff-only rather than everybody's — see the model column comment.
    """
    if ticket.raised_by is None or ticket.raised_by != viewer.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ticket not found")


def list_my_tickets(
    db: Session, viewer: User, *, status_filter: str | None = None, open_only: bool = False
) -> list[TicketOut]:
    """The raiser's own tickets. Never carries a comment count — see the module docstring."""
    stmt = (
        select(HelpdeskTicket)
        .where(HelpdeskTicket.org_id == viewer.org_id, HelpdeskTicket.raised_by == viewer.id)
        .order_by(HelpdeskTicket.created_at.desc())
    )
    if status_filter:
        stmt = stmt.where(HelpdeskTicket.status == status_filter)
    elif open_only:
        stmt = stmt.where(
            HelpdeskTicket.status.in_([TicketStatus.OPEN.value, TicketStatus.IN_PROGRESS.value])
        )
    tickets = list(db.scalars(stmt).all())
    names = _names(db, viewer.org_id)
    categories = _category_names(db, viewer.org_id)
    return [TicketOut(**_base_fields(t, names, categories)) for t in tickets]


def _comment_counts(
    db: Session, org_id: uuid.UUID, ticket_ids: list[uuid.UUID]
) -> dict[uuid.UUID, tuple[int, int]]:
    """(total, internal) per ticket, in one query rather than one per row."""
    if not ticket_ids:
        return {}
    counts: dict[uuid.UUID, tuple[int, int]] = {}
    for row in db.execute(
        select(
            HelpdeskComment.ticket_id,
            HelpdeskComment.is_internal,
            func.count(HelpdeskComment.id),
        )
        .where(
            HelpdeskComment.org_id == org_id,
            HelpdeskComment.ticket_id.in_(ticket_ids),
        )
        .group_by(HelpdeskComment.ticket_id, HelpdeskComment.is_internal)
    ):
        total, internal = counts.get(row[0], (0, 0))
        n = int(row[2])
        counts[row[0]] = (total + n, internal + (n if row[1] else 0))
    return counts


def list_queue(
    db: Session,
    staff: User,
    *,
    status_filter: str | None = None,
    assigned_to: uuid.UUID | None = None,
    mine_only: bool = False,
    unassigned_only: bool = False,
    category_id: uuid.UUID | None = None,
    open_only: bool = True,
) -> list[TicketStaffOut | TicketOut]:
    """The HR queue. Staff-gated at the router; counts are per-row, per D-026.

    Ordered by priority rank then age, so "wake someone up" does not sit under
    a week of ``low``. The rank comes from the model rather than a SQL CASE so
    there is one ordering of the four levels in the codebase.

    **The list is deliberately mixed.** A manager assigned ticket A but not
    ticket B gets counts on A and a row with no count keys at all on B. It
    would be tidier to return one shape throughout and zero the counts on the
    rows they may not read -- and it would be wrong, because "0 internal notes"
    is an assertion about a ticket, not the absence of one. The whole point of
    the count boundary is that the reader learns nothing, and a confident zero
    teaches them exactly as much as a confident eight. Absent key, absent
    knowledge.
    """
    stmt = select(HelpdeskTicket).where(HelpdeskTicket.org_id == staff.org_id)
    if status_filter:
        stmt = stmt.where(HelpdeskTicket.status == status_filter)
    elif open_only:
        stmt = stmt.where(
            HelpdeskTicket.status.in_([TicketStatus.OPEN.value, TicketStatus.IN_PROGRESS.value])
        )
    if mine_only:
        stmt = stmt.where(HelpdeskTicket.assigned_to == staff.id)
    elif unassigned_only:
        stmt = stmt.where(HelpdeskTicket.assigned_to.is_(None))
    elif assigned_to is not None:
        stmt = stmt.where(HelpdeskTicket.assigned_to == assigned_to)
    if category_id is not None:
        stmt = stmt.where(HelpdeskTicket.category_id == category_id)

    tickets = list(db.scalars(stmt).all())
    tickets.sort(key=lambda t: (-t.priority_enum.rank, t.created_at))

    names = _names(db, staff.org_id)
    categories = _category_names(db, staff.org_id)
    # Counted for the whole page in one query even though some rows will not
    # carry the numbers: the alternative is a second query shaped by who is
    # asking, and a query plan that varies with the caller's permissions is how
    # a "why is this slow for one user" ticket gets filed against the helpdesk.
    counts = _comment_counts(db, staff.org_id, [t.id for t in tickets])

    rows: list[TicketStaffOut | TicketOut] = []
    for t in tickets:
        fields = _base_fields(t, names, categories)
        if may_read_internal_notes(staff, t):
            total, internal = counts.get(t.id, (0, 0))
            rows.append(
                TicketStaffOut(**fields, comment_count=total, internal_comment_count=internal)
            )
        else:
            rows.append(TicketOut(**fields))
    return rows


def redacted_detail(db: Session, ticket: HelpdeskTicket) -> TicketDetailOut:
    """Ticket detail WITHOUT internal notes, and without any trace of them.

    Two audiences reach this shape, and after D-026 they are not the same
    people: the employee who raised the ticket, and any helpdesk staff member
    who is neither an administrator nor the assignee. The function does not ask
    which -- it cannot disclose to either, so it does not need to know.

    ``PublicCommentOut.from_visible`` is given the whole thread and does the
    filtering itself, and the resulting type cannot hold an internal row: if a
    future edit here ever hands it a pre-filtered list that still contains one,
    the response raises instead of disclosing. That is the trade the schema was
    designed for; do not "optimise" it into a filtered query that the type can
    no longer check.

    No counts. A count is a disclosure -- see the module docstring.
    """
    names = _names(db, ticket.org_id)
    categories = _category_names(db, ticket.org_id)
    return TicketDetailOut(
        **_base_fields(ticket, names, categories),
        comments=PublicCommentOut.from_visible(_comment_rows(ticket, names)),
    )


def internal_detail(db: Session, ticket: HelpdeskTicket) -> TicketStaffDetailOut:
    """Ticket detail WITH internal notes. Only for a caller D-026 admits.

    A sibling of ``redacted_detail``, never a superset of it, so no signature
    anywhere can accept one where the other is expected. Call it only through
    ``detail_for``, which is where the entitlement is decided.
    """
    names = _names(db, ticket.org_id)
    categories = _category_names(db, ticket.org_id)
    rows = _comment_rows(ticket, names)
    return TicketStaffDetailOut(
        **_base_fields(ticket, names, categories),
        comments=[StaffCommentOut.model_validate(r) for r in rows],
        comment_count=len(rows),
        internal_comment_count=sum(1 for r in rows if r.is_internal),
    )


def detail_for(
    db: Session, viewer: User, ticket: HelpdeskTicket
) -> TicketStaffDetailOut | TicketDetailOut:
    """The one place a ticket detail's audience is decided. D-026 lives here.

    The return type is a union, and the staff route that calls it therefore
    declares ``response_model=None``. That looks like a step backwards from a
    statically declared shape, and it is worth being explicit about why it is
    not: the guarantee in this module was never that FastAPI filtered the
    response. It is that ``PublicCommentOut.is_internal`` is ``Literal[False]``,
    so the redacted branch physically cannot carry an internal note whatever
    the route declares. A union response_model would be strictly worse -- it
    would let Pydantic pick a member, and "whichever one validates" is not a
    security decision anybody should be delegating.

    The shapes are distinguishable by the client without a flag: the entitled
    branch carries ``comment_count``, the redacted one has no such key at all.
    """
    if may_read_internal_notes(viewer, ticket):
        return internal_detail(db, ticket)
    return redacted_detail(db, ticket)


def ticket_out(db: Session, ticket: HelpdeskTicket) -> TicketOut:
    """A list/summary row with no comment counts on it."""
    names = _names(db, ticket.org_id)
    return TicketOut(**_base_fields(ticket, names, _category_names(db, ticket.org_id)))


def staff_out(db: Session, ticket: HelpdeskTicket) -> TicketStaffOut:
    """A list/summary row carrying the counts. Only for a caller D-026 admits."""
    names = _names(db, ticket.org_id)
    counts = _comment_counts(db, ticket.org_id, [ticket.id]).get(ticket.id, (0, 0))
    return TicketStaffOut(
        **_base_fields(ticket, names, _category_names(db, ticket.org_id)),
        comment_count=counts[0],
        internal_comment_count=counts[1],
    )


def row_for(
    db: Session, viewer: User, ticket: HelpdeskTicket
) -> TicketStaffOut | TicketOut:
    """The row shape one viewer is entitled to, for every staff write response.

    Every mutation on the staff surface echoes the ticket back, so each of them
    is a read path too. Returning ``TicketStaffOut`` unconditionally would mean
    a manager who may not read this ticket's notes learns how many there are by
    changing its priority -- the disclosure D-026 closes, leaking back through
    the door marked "write".
    """
    if may_read_internal_notes(viewer, ticket):
        return staff_out(db, ticket)
    return ticket_out(db, ticket)


# --------------------------------------------------------------------------- #
# Tickets — writes
# --------------------------------------------------------------------------- #


def _default_assignee(db: Session, org_id: uuid.UUID, category: HelpdeskCategory | None) -> User | None:
    """Resolve a category's routing hint to a person, or to nobody.

    ``default_assignee_role`` is a hint, not an access grant: the candidate
    still has to pass ``is_helpdesk_staff``. A category pointed at ``employee``
    therefore resolves to nobody rather than handing a ticket — and with it the
    internal notes that follow — to someone the flag excludes. Unassigned is a
    normal state; the triage queue is where it lands.

    Deterministic by name so two orgs with the same shape route the same way
    and a test is not at the mercy of row order.
    """
    if category is None or not category.default_assignee_role:
        return None
    candidates = db.scalars(
        select(User)
        .where(
            User.org_id == org_id,
            User.role == category.default_assignee_role,
            User.is_active.is_(True),
        )
        .order_by(User.full_name)
    ).all()
    for candidate in candidates:
        if is_helpdesk_staff(candidate):
            return candidate
    return None


def raise_ticket(db: Session, raiser: User, payload: TicketIn) -> HelpdeskTicket:
    """Create a ticket. Commits, then alerts — see ``_notify`` for why.

    The source pair is verified before the row is built, not after: a ticket
    that was written and then rejected would still have answered the attacker's
    question, whatever the response said.
    """
    verify_source(db, raiser, payload)

    category = None
    if payload.category_id is not None:
        category = get_category(db, raiser.org_id, payload.category_id)
        if not category.is_active:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "That category is no longer accepting tickets"
            )

    assignee = _default_assignee(db, raiser.org_id, category)
    ticket = HelpdeskTicket(
        org_id=raiser.org_id,
        raised_by=raiser.id,
        category_id=category.id if category else None,
        subject=payload.subject.strip(),
        description=payload.description,
        status=TicketStatus.OPEN.value,
        priority=payload.priority,
        assigned_to=assignee.id if assignee else None,
        source_module=payload.source_module,
        source_ref=payload.source_ref,
    )
    db.add(ticket)
    db.commit()
    db.refresh(ticket)

    if assignee is not None:
        _notify_assigned(db, ticket, assignee, actor=raiser)
    return ticket


def _resolve_assignee(db: Session, org_id: uuid.UUID, user_id: uuid.UUID) -> User:
    """The target of an assignment, refused unless they may work the helpdesk.

    Assigning a ticket is how someone starts reading its internal notes, so
    this is an access decision wearing a workflow decision's clothes. A person
    whose ``can_manage_helpdesk`` is off must not become an assignee by the
    side door — the flag would then restrict the queue page and grant the notes.
    """
    target = db.get(User, user_id)
    if target is None or target.org_id != org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Employee not found")
    if not is_helpdesk_staff(target):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "reason": "assignee_not_helpdesk_staff",
                "message": (
                    "That employee is not permitted to work helpdesk tickets, so "
                    "they cannot be assigned one."
                ),
            },
        )
    return target


def _apply_status(ticket: HelpdeskTicket, new_status: str) -> None:
    """The single place the two timestamps are stamped or cleared.

    * ``resolved`` stamps ``resolved_at`` and clears ``closed_at``.
    * ``closed`` stamps ``closed_at`` and leaves ``resolved_at`` alone, so a
      ticket closed as a duplicate keeps a NULL resolution date instead of
      poisoning mean-time-to-resolution with a fix that never happened.
    * Anything reopening the ticket clears **both**. ``resolved_at`` therefore
      always means "when the fix that currently stands was delivered", never
      "the first time somebody tried" — which is the only reading under which
      an SLA report is honest about a ticket that bounced three times.

    Re-resolving an already-resolved ticket keeps the original stamp: nothing
    changed, so the clock should not restart.
    """
    now = _now()
    if new_status == TicketStatus.RESOLVED.value:
        if ticket.status != TicketStatus.RESOLVED.value or ticket.resolved_at is None:
            ticket.resolved_at = now
        ticket.closed_at = None
    elif new_status == TicketStatus.CLOSED.value:
        if ticket.closed_at is None:
            ticket.closed_at = now
    else:
        ticket.resolved_at = None
        ticket.closed_at = None
    ticket.status = new_status


def update_ticket(
    db: Session, staff: User, ticket: HelpdeskTicket, payload: TicketUpdateIn
) -> HelpdeskTicket:
    """Staff-side edit. Commits, then alerts.

    ``source_module`` / ``source_ref`` are absent from ``TicketUpdateIn`` and
    are not settable here by any other route: where a ticket came from is a
    fact about the moment it was raised. Re-pointing it after the fact would
    rewrite the provenance the link exists to record — and would bypass the
    write-time visibility check that ``raise_ticket`` runs.
    """
    newly_assigned: User | None = None
    became_resolved = False

    if payload.clear_assignee:
        ticket.assigned_to = None
    elif payload.assigned_to is not None and payload.assigned_to != ticket.assigned_to:
        newly_assigned = _resolve_assignee(db, staff.org_id, payload.assigned_to)
        ticket.assigned_to = newly_assigned.id

    if payload.category_id is not None:
        ticket.category_id = get_category(db, staff.org_id, payload.category_id).id
    if payload.priority is not None:
        ticket.priority = payload.priority

    if payload.status is not None and payload.status != ticket.status:
        became_resolved = payload.status == TicketStatus.RESOLVED.value
        _apply_status(ticket, payload.status)

    db.commit()
    db.refresh(ticket)

    if newly_assigned is not None:
        _notify_assigned(db, ticket, newly_assigned, actor=staff)
    if became_resolved:
        _notify_resolved(db, ticket, actor=staff)
    return ticket


def assign(
    db: Session, staff: User, ticket: HelpdeskTicket, assignee_id: uuid.UUID | None
) -> HelpdeskTicket:
    """Assign, or unassign with an explicit ``None``."""
    if assignee_id is None:
        ticket.assigned_to = None
        db.commit()
        db.refresh(ticket)
        return ticket

    assignee = _resolve_assignee(db, staff.org_id, assignee_id)
    changed = ticket.assigned_to != assignee.id
    ticket.assigned_to = assignee.id
    db.commit()
    db.refresh(ticket)
    if changed:
        _notify_assigned(db, ticket, assignee, actor=staff)
    return ticket


def set_status(db: Session, actor: User, ticket: HelpdeskTicket, new_status: str) -> HelpdeskTicket:
    """Move a ticket, stamping the timestamps the transition implies."""
    became_resolved = (
        new_status == TicketStatus.RESOLVED.value and ticket.status != TicketStatus.RESOLVED.value
    )
    _apply_status(ticket, new_status)
    db.commit()
    db.refresh(ticket)
    if became_resolved:
        _notify_resolved(db, ticket, actor=actor)
    return ticket


def reopen(db: Session, actor: User, ticket: HelpdeskTicket) -> HelpdeskTicket:
    """Back into the queue, with both timestamps cleared.

    Refused on a ticket that is already open or in progress, so "reopen" is
    never a silent way to wipe a resolution date off a live ticket.
    """
    if ticket.status_enum.is_open:
        raise HTTPException(status.HTTP_409_CONFLICT, "That ticket is already open")
    return set_status(db, actor, ticket, TicketStatus.OPEN.value)


def employee_reopen(db: Session, raiser: User, ticket: HelpdeskTicket) -> HelpdeskTicket:
    """The raiser rejecting a fix. Only from ``resolved``.

    ``resolved`` is deliberately not terminal (see ``TicketStatus.is_terminal``)
    precisely so the person who reported the problem gets to say it is not
    fixed. ``closed`` is terminal, and an employee may not reopen it: that
    decision belongs to staff, or to a new ticket.
    """
    if ticket.status != TicketStatus.RESOLVED.value:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "reason": "not_reopenable",
                "message": "Only a resolved ticket can be reopened. Raise a new one instead.",
            },
        )
    return set_status(db, raiser, ticket, TicketStatus.OPEN.value)


def employee_close(db: Session, raiser: User, ticket: HelpdeskTicket) -> HelpdeskTicket:
    """The raiser withdrawing their own ticket.

    This is the path ``closed_at`` exists as a separate column for: it ends
    without ever having been resolved, and stamping ``resolved_at`` here would
    book a fix that nobody delivered into the resolution-time average.
    """
    if ticket.status == TicketStatus.CLOSED.value:
        raise HTTPException(status.HTTP_409_CONFLICT, "That ticket is already closed")
    return set_status(db, raiser, ticket, TicketStatus.CLOSED.value)


# --------------------------------------------------------------------------- #
# Comments
# --------------------------------------------------------------------------- #


def add_comment(
    db: Session, ticket: HelpdeskTicket, author: User, body: str, *, is_internal: bool
) -> HelpdeskComment:
    """Append to the thread. ``is_internal`` is keyword-only and never defaulted.

    The keyword-only argument is the same discipline as
    ``HelpdeskTicket.comments_for``: every call site has to state, on the line
    a reviewer reads, which audience it is writing for. A default here would be
    the entire bug — it would make "forgot the flag" produce a silently
    published note rather than a TypeError.

    The caller is responsible for having established that the author may write
    an internal note at all; the employee-facing router path passes
    ``is_internal=False`` as a literal and its request schema has no such field,
    so an employee cannot reach the other value.
    """
    comment = HelpdeskComment(
        org_id=ticket.org_id,
        ticket_id=ticket.id,
        author_id=author.id,
        body=body,
        is_internal=is_internal,
    )
    db.add(comment)
    db.commit()
    db.refresh(comment)
    return comment


def public_comment(db: Session, ticket: HelpdeskTicket, comment: HelpdeskComment) -> PublicCommentOut:
    """Serialise one comment for the employee. Raises on an internal row.

    Routed through ``from_visible`` rather than ``model_validate`` so the
    filter and the type are the same two lines every other read path uses.
    ``from_visible`` drops an internal row instead of raising, so the empty
    list below is turned into a 500 explicitly: an employee-facing path that
    somehow authored an internal note must fail loudly, and it must never fall
    through to returning something else.
    """
    names = _names(db, ticket.org_id)
    rows = [
        r for r in _comment_rows(ticket, names) if r.id == comment.id
    ]
    visible = PublicCommentOut.from_visible(rows)
    if not visible:
        # Only reachable if an employee-facing path somehow authored an
        # internal note. Fail loudly rather than answer with something else.
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Comment could not be rendered")
    return visible[0]


def staff_comment(db: Session, ticket: HelpdeskTicket, comment: HelpdeskComment) -> StaffCommentOut:
    names = _names(db, ticket.org_id)
    for row in _comment_rows(ticket, names):
        if row.id == comment.id:
            return StaffCommentOut.model_validate(row)
    raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Comment could not be rendered")


def can_comment(ticket: HelpdeskTicket) -> None:
    """The employee-side guard only; staff may still annotate a closed ticket.

    For the employee a closed thread is a conversation nobody is watching, and
    letting them type into it is worse than telling them to raise a new ticket.
    For staff the thread is the record, and the note explaining why something
    was closed as a duplicate is written after the closure by definition.
    """
    if ticket.status == TicketStatus.CLOSED.value:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "reason": "ticket_closed",
                "message": "This ticket is closed. Raise a new one to continue the conversation.",
            },
        )


# --------------------------------------------------------------------------- #
# Alerts — both optional, both through the one door
# --------------------------------------------------------------------------- #


def _notify(db: Session, recipient: User | None, kind, dedupe_key: str, subject: str, body: str) -> None:
    """Every helpdesk alert goes through ``notifications.dispatch``, always.

    Two ordering rules this wrapper exists to hold:

    * The caller has already committed. ``dispatch`` writes and commits its
      claim row before sending, and rolls the session back when another runner
      won the same key — which would discard an uncommitted ticket change
      sitting in the same session. Commit first, alert second.
    * A mail failure must never fail the request. ``dispatch`` already swallows
      SMTP errors into a log row; this catches the rest, because a ticket that
      was assigned and then 500'd is worse than an alert nobody received.
    """
    if recipient is None:
        return
    try:
        notif.dispatch(db, recipient, kind, dedupe_key, subject, body)
    except Exception:  # noqa: BLE001
        db.rollback()


def _notify_assigned(db: Session, ticket: HelpdeskTicket, assignee: User, *, actor: User) -> None:
    if assignee.id == actor.id:
        # Nobody needs an email telling them what they just did.
        return
    _notify(
        db,
        assignee,
        notif.Kind.TICKET_ASSIGNED,
        # Keyed on the pair, so re-assigning to the same person after a detour
        # is silent. An event, not a condition: one mail per person per ticket
        # is the version that cannot spam a queue during triage churn.
        f"ticket-assigned:{ticket.id}:{assignee.id}",
        f"Helpdesk ticket assigned to you: {ticket.subject}",
        f"A support ticket has been assigned to you.\n\n{ticket.subject}\n",
    )


def _notify_resolved(db: Session, ticket: HelpdeskTicket, *, actor: User) -> None:
    if ticket.raised_by is None or ticket.raised_by == actor.id:
        return
    raiser = db.get(User, ticket.raised_by)
    if raiser is None or raiser.org_id != ticket.org_id:
        return
    stamp = ticket.resolved_at.isoformat() if ticket.resolved_at else "unknown"
    _notify(
        db,
        raiser,
        notif.Kind.TICKET_RESOLVED,
        # The resolution timestamp is in the key on purpose. A ticket that was
        # reopened and resolved again is a genuinely new event and the person
        # waiting on it has to hear about it — and because reopening clears
        # ``resolved_at``, the second resolution always produces a new key.
        f"ticket-resolved:{ticket.id}:{stamp}",
        f"Your helpdesk ticket was resolved: {ticket.subject}",
        f"Your support ticket has been marked resolved.\n\n{ticket.subject}\n",
    )
