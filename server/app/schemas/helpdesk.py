"""Request/response shapes for the helpdesk module.

**Read this before adding anything to this file.**

An internal comment is HR's private note about an employee. It must never be
serialised into a response that employee can receive. Every ticketing system
that has leaked one leaked it the same way: there was a single ``CommentOut``,
it carried ``is_internal``, and one handler somewhere forgot to filter before
returning it. The bug is invisible in review because the filtering happens
three files away from the type.

So this module has **no** ``CommentOut``. The audience is encoded in the type:

* ``PublicCommentOut``  -- may be sent to the employee who raised the ticket.
* ``StaffCommentOut``   -- may be sent only to helpdesk staff.

and the same split runs through the ticket detail and even the comment counts:

* ``TicketDetailOut``      -- employee-facing; nests ``PublicCommentOut``.
* ``TicketStaffDetailOut`` -- staff-facing; nests ``StaffCommentOut``.

The naming is a hint, not the guarantee. The guarantee is that
``PublicCommentOut.is_internal`` is typed ``Literal[False]``: feeding it an
internal row raises ``ValidationError`` instead of returning one. Picking the
wrong type is therefore a 500 in staging, not a disclosure in production --
which is the only trade in this file worth making. Do not "fix" that field to
``bool`` to make a test pass; the failure is the feature.

The same reasoning applies to the counts. ``TicketOut`` carries no comment
count at all, because telling an employee their ticket has 12 comments when
they can read 4 discloses that 8 notes about them exist. Counts live only on
the staff shapes.

By contrast ``source_module`` / ``source_ref`` sit on the shared ``TicketOut``
and are shown to both audiences; the argument for that is on ``TicketOut``
itself, since it is the one place a reviewer will look to check it.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Iterable, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.common import ORMModel

# Mirrors app.models.helpdesk.TicketStatus / TicketPriority. Duplicated as
# Literals rather than imported as enums so a bad value is a 422 at the edge
# with a readable message, which is how the rest of this codebase validates
# enum-ish strings (see RuleCreate.match_type in schemas/common.py).
TicketStatusLiteral = Literal["open", "in_progress", "resolved", "closed"]
TicketPriorityLiteral = Literal["low", "normal", "high", "urgent"]
AssigneeRoleLiteral = Literal["owner", "admin", "manager", "employee"]


# --------------------------------------------------------------------------
# Categories
# --------------------------------------------------------------------------


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    # None means "leave it in the triage bucket for whoever picks it up".
    default_assignee_role: AssigneeRoleLiteral | None = None
    is_active: bool = True


class CategoryOut(ORMModel):
    id: uuid.UUID
    name: str
    description: str | None = None
    default_assignee_role: str | None = None
    is_active: bool
    # Derived, so the categories table needs no client-side joins.
    open_ticket_count: int = 0
    ticket_count: int = 0


# --------------------------------------------------------------------------
# Comments -- the audience split
# --------------------------------------------------------------------------


class _CommentFields(ORMModel):
    """Fields common to both audiences. Never use this as a ``response_model``.

    It is private (leading underscore, absent from any router import) precisely
    so that "just return the base class" is not an available shortcut: the base
    class carries no ``is_internal`` at all, so returning it would silently
    publish internal notes with the incriminating flag stripped off -- the
    worst possible outcome, because the response would look clean.
    """

    id: uuid.UUID
    ticket_id: uuid.UUID
    author_id: uuid.UUID | None = None
    body: str
    created_at: datetime
    # Resolved name so a thread needs no client-side joins. None once the
    # author's user row is gone (author_id is ON DELETE SET NULL).
    author_name: str | None = None


class PublicCommentOut(_CommentFields):
    """A comment the employee who raised the ticket is allowed to read.

    ``is_internal`` is pinned to ``Literal[False]``. Validating an internal row
    into this class raises ``ValidationError``. That is the enforcement: a
    handler that forgets to filter fails loudly on the first internal note
    instead of quietly disclosing it.
    """

    is_internal: Literal[False] = False

    @classmethod
    def from_visible(cls, comments: Iterable[object]) -> list["PublicCommentOut"]:
        """Filter to the employee-visible subset, then convert.

        Filter-then-convert, never convert-then-filter: converting first would
        raise on the first internal note in a perfectly ordinary thread.

        ``getattr(c, "is_internal", True)`` defaults to *internal* on purpose.
        If the attribute is ever missing -- a dict, a stub, a partially loaded
        row -- the safe reading of "I do not know what this is" is to withhold
        it. Fail closed.
        """
        return [cls.model_validate(c) for c in comments if not getattr(c, "is_internal", True)]


class StaffCommentOut(_CommentFields):
    """A comment for helpdesk staff. May be an internal note -- check the flag.

    Only ever return this from a handler gated on ``can_manage_helpdesk``.
    """

    is_internal: bool
    # Role of the author at read time, so the thread can badge HR replies
    # differently from the employee's own. Staff-only: it is one more signal
    # about who is talking about you behind the ticket.
    author_role: str | None = None


class CommentIn(BaseModel):
    """A reply written by the employee on their own ticket.

    There is deliberately no ``is_internal`` field, and ``extra="forbid"`` so a
    client that sends one gets a 422 rather than having it quietly dropped. An
    employee cannot author an internal note, and the schema -- not a runtime
    check someone can forget -- is what makes that true.
    """

    model_config = ConfigDict(extra="forbid")

    body: str = Field(min_length=1, max_length=10000)


class StaffCommentIn(BaseModel):
    """A comment written by helpdesk staff.

    ``is_internal`` is **required**, with no default. Both defaults are wrong:
    defaulting to False leaks the note the one time an HR user forgets the
    toggle, defaulting to True hides replies that were meant to be answers and
    leaves the employee staring at silence. Making the caller say it every time
    is the only version that cannot fail silently, and it costs one keystroke
    in a UI that already renders the toggle.
    """

    model_config = ConfigDict(extra="forbid")

    body: str = Field(min_length=1, max_length=10000)
    is_internal: bool


# --------------------------------------------------------------------------
# Tickets
# --------------------------------------------------------------------------


class TicketIn(BaseModel):
    """What an employee may set when raising a ticket.

    Notably absent: ``status`` and ``assigned_to``. A raiser does not get to
    open a ticket pre-assigned or pre-resolved; those move through
    ``TicketUpdateIn``, which is staff-gated.
    """

    subject: str = Field(min_length=1, max_length=300)
    description: str = Field(min_length=1, max_length=20000)
    category_id: uuid.UUID | None = None
    priority: TicketPriorityLiteral = "normal"
    # Optional back-link to whatever the employee raised this from -- see the
    # long comment on the model columns for why this is not a foreign key.
    #
    # The service MUST verify that the raiser may actually see the referenced
    # row before storing it. Not for the link's sake (a link they cannot open
    # renders as "unavailable" anyway) but because an unchecked write turns
    # this field into a probe: post a ticket per guessed UUID and read the
    # rendered link to learn which ids exist. Cheap to check at write time,
    # impossible to retrofit once tickets carry unvetted refs.
    source_module: str | None = Field(default=None, max_length=40)
    source_ref: uuid.UUID | None = None

    @model_validator(mode="after")
    def _source_pair(self) -> "TicketIn":
        """Both or neither, mirroring ck_helpdesk_tickets_source_pair.

        Duplicated here so a half-filled link is a 422 naming the field rather
        than an IntegrityError surfacing as a 500 with a constraint name in it.
        """
        if (self.source_module is None) != (self.source_ref is None):
            raise ValueError("source_module and source_ref must be set together or not at all")
        return self


class TicketUpdateIn(BaseModel):
    """Staff-side edits. Every field optional; None means "leave unchanged".

    ``resolved_at`` and ``closed_at`` are not settable here. They are derived
    from the status transition by the service, because a timestamp a client can
    set independently of the status it is supposed to describe will eventually
    disagree with it, and then every SLA report is wrong.
    """

    status: TicketStatusLiteral | None = None
    priority: TicketPriorityLiteral | None = None
    category_id: uuid.UUID | None = None
    assigned_to: uuid.UUID | None = None
    # None already means "leave unchanged", so unassigning needs its own flag.
    clear_assignee: bool = False
    # source_module / source_ref are deliberately absent. Where a ticket came
    # from is a fact about the moment it was raised; it is set once at creation
    # and is not an editable property. Letting staff re-point it would let them
    # rewrite a ticket's provenance after the fact, which is exactly what the
    # link exists to record.


class TicketOut(ORMModel):
    """List-row shape, safe for either audience.

    Carries no comment count on purpose -- see the module docstring. Anything
    added here is visible to the employee who raised the ticket; if that is not
    true of a field, it belongs on ``TicketStaffOut``.

    ``source_module`` / ``source_ref`` are on this shared base deliberately, so
    the employee sees them too. In the flow that motivated the pair, the
    employee raised the ticket *from* their own rejected regularization -- both
    ends of that link are already their record, and hiding the back-link turns
    "dispute this" into a one-way door they cannot navigate back through. The
    pair also discloses nothing on its own: it is a module name they already
    use plus an opaque id, and the id is a pointer rather than a grant, so the
    target module still authorises the click and a denial renders as the same
    "linked item unavailable" as a dangling ref.

    That reasoning holds only because ``TicketOut`` is reachable exclusively by
    the ticket's own raiser or by staff. It is not a general licence to put
    module cross-references on employee-facing shapes.
    """

    id: uuid.UUID
    subject: str
    description: str
    status: str
    priority: str
    category_id: uuid.UUID | None = None
    raised_by: uuid.UUID | None = None
    assigned_to: uuid.UUID | None = None
    created_at: datetime
    resolved_at: datetime | None = None
    closed_at: datetime | None = None
    source_module: str | None = None
    source_ref: uuid.UUID | None = None
    # Derived display fields, so a ticket table needs no client-side joins.
    category_name: str | None = None
    raised_by_name: str | None = None
    assigned_to_name: str | None = None


class TicketStaffOut(TicketOut):
    """List row for the HR queue. Adds counts that would leak to an employee."""

    comment_count: int = 0
    internal_comment_count: int = 0


class TicketDetailOut(TicketOut):
    """Ticket detail **for the employee who raised it**.

    ``comments`` holds only what they may read. Build it with
    ``PublicCommentOut.from_visible(ticket.comments)`` -- or, equivalently,
    ``ticket.comments_for(include_internal=False)`` -- never by handing this
    field the raw relationship, which would raise on the first internal note.
    """

    comments: list[PublicCommentOut] = []


class TicketStaffDetailOut(TicketOut):
    """Ticket detail for helpdesk staff. Contains internal notes.

    Only return this from a handler gated on ``can_manage_helpdesk``. It is a
    sibling of ``TicketDetailOut``, not a subclass of it, so that no amount of
    upcasting can make a staff payload satisfy an employee-facing signature.
    """

    comments: list[StaffCommentOut] = []
    comment_count: int = 0
    internal_comment_count: int = 0
