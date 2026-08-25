"""Helpdesk tickets, their categories and their comment thread.

The one thing a reader must not get wrong: **``HelpdeskComment.is_internal`` is
a security boundary, not a display preference.** An internal note is HR's
private working record about an employee -- "spoke to her manager, this is the
third complaint", "legal says do not put anything in writing" -- and it must
never reach the employee who raised the ticket. There is no "we showed it
collapsed" version of that failure: once it is rendered it is disclosed.

Two consequences that shape this module:

1. Nothing here ever hands out a comment row. The visibility decision lives in
   ``app.schemas.helpdesk``, which deliberately has **no** single ``CommentOut``
   type -- the employee-facing and staff-facing shapes are different classes,
   and the employee-facing one refuses to serialise an internal row at all. A
   handler that reaches for the wrong type raises; it does not leak.
2. Counts leak too. "12 comments" on a ticket whose author can see 4 tells that
   author there are 8 notes about them. So the counts are split the same way
   the bodies are; see the ``*Out`` schemas.

This module has **no** foreign keys into attendance, leave, regularization,
assets or onboarding, and it must stay that way. Helpdesk is the one module
that has to stand up on its own; other modules link *into* a ticket by creating
one, never by the ticket pointing back at them.

The one concession to that rule is the ``source_module`` / ``source_ref`` pair
on ``HelpdeskTicket``, which is deliberately *not* a foreign key. It exists so
that "dispute this rejected regularization" has somewhere to put its back-link
that is not a real constraint into another module's table. Read the comment on
those columns before touching them.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    Uuid,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDMixin

if TYPE_CHECKING:
    from app.models.user import User


class TicketStatus(str, enum.Enum):
    OPEN = "open"
    IN_PROGRESS = "in_progress"
    RESOLVED = "resolved"
    CLOSED = "closed"

    @property
    def is_terminal(self) -> bool:
        """``resolved`` is not terminal -- the employee can still reject the fix.

        Only ``closed`` ends a ticket's life. Treating ``resolved`` as final is
        how a helpdesk ends up with a queue that looks empty while people are
        still waiting, so the distinction is load-bearing, not cosmetic.
        """
        return self is TicketStatus.CLOSED

    @property
    def is_open(self) -> bool:
        """What an "open tickets" badge counts: anything still owed work."""
        return self in (TicketStatus.OPEN, TicketStatus.IN_PROGRESS)


class TicketPriority(str, enum.Enum):
    """Four levels, deliberately.

    Three is too few: collapsing "jump the queue" and "interrupt someone now"
    into one bucket means every escalation becomes ``high`` and the field stops
    carrying information within a month. Five or more is too many -- nobody
    ever agrees on P4 versus P5 and the bottom levels decay into synonyms.
    Four is the smallest set that maps onto decisions HR actually makes: below
    the queue, in the queue, ahead of the queue, and wake someone up.
    """

    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    URGENT = "urgent"

    @property
    def rank(self) -> int:
        """Higher sorts first. Queue ordering only -- never a permission."""
        return {"low": 0, "normal": 1, "high": 2, "urgent": 3}[self.value]


class HelpdeskCategory(UUIDMixin, TimestampMixin, Base):
    """A ticket bucket ("Payroll", "IT access", "Grievance") plus its routing.

    ``default_assignee_role`` is a *routing hint*, not an access grant. It holds
    a ``Role`` value because that is the only role vocabulary this product has;
    the real gate on who may work helpdesk is the per-employee
    ``can_manage_helpdesk`` flag, exactly like ``can_approve_timesheets``.
    Resolving the hint to a person is the service's job, and it must never
    widen access to someone the flag excludes.
    """

    __tablename__ = "helpdesk_categories"
    __table_args__ = (
        UniqueConstraint("org_id", "name", name="uq_helpdesk_categories_org_name"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Role tier that tickets in this category land on by default. Nullable
    # because "whoever picks it up" is a legitimate configuration, and better
    # than forcing an admin to invent an owner for a triage bucket.
    default_assignee_role: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # Retire a category without touching the tickets filed under it. Soft
    # delete for the same reason departments have it: a historical ticket has
    # to keep saying what it was about.
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    tickets: Mapped[list["HelpdeskTicket"]] = relationship(back_populates="category")


class HelpdeskTicket(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "helpdesk_tickets"
    __table_args__ = (
        # The HR queue: everything still owed work in this org, by status.
        Index("ix_helpdesk_tickets_org_status", "org_id", "status"),
        # "My tickets" on the employee home dashboard.
        Index("ix_helpdesk_tickets_org_raised_by", "org_id", "raised_by"),
        # "Assigned to me" -- the screen an HR user lives in all day.
        Index("ix_helpdesk_tickets_org_assigned_status", "org_id", "assigned_to", "status"),
        # Answers "does a ticket already exist for this rejected
        # regularization?", which is what stops the dispute button opening a
        # fifth duplicate ticket for the same row.
        Index("ix_helpdesk_tickets_org_source", "org_id", "source_module", "source_ref"),
        # Both or neither. A source_ref with no source_module is a UUID with no
        # table to look it up in -- unresolvable by construction, and it would
        # sit there looking like data. Enforced in the database rather than only
        # in Pydantic, for the same reason regularization does it: the seeder
        # and any future bulk-import job bypass the schemas entirely.
        #
        # The comparison is safe on both backends: ``IS NULL`` yields a real
        # boolean (0/1 on SQLite), never NULL, so this never evaluates to
        # unknown and never silently passes.
        CheckConstraint(
            "(source_module IS NULL) = (source_ref IS NULL)",
            # The metadata naming convention expands this to
            # ck_helpdesk_tickets_source_pair.
            name="source_pair",
        ),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # SET NULL, not CASCADE. A resignation must not silently delete the
    # grievance the person filed on their way out -- that ticket is precisely
    # the record the company will later be asked to produce. In practice this
    # codebase deactivates users (``User.is_active``) rather than deleting
    # them, so this only fires on a genuine hard delete; when it does, an
    # unattributed ticket beats losing the thread entirely.
    #
    # The nullability is also a safe failure mode for authorisation: the
    # "am I the raiser?" check is ``ticket.raised_by == current_user.id``, and
    # NULL matches nobody -- so an orphaned ticket becomes staff-only rather
    # than becoming everybody's.
    raised_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # SET NULL: unassigned is a normal, expected state -- it is the state every
    # ticket starts in -- so losing the assignee simply returns the ticket to
    # the triage queue where a human picks it up again.
    assigned_to: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # SET NULL rather than RESTRICT: deleting a category is an admin tidying a
    # config list, and that action must never be able to destroy -- or be
    # blocked by -- a year of ticket history.
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("helpdesk_categories.id", ondelete="SET NULL"), nullable=True, index=True
    )

    subject: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)

    status: Mapped[str] = mapped_column(
        String(20), default=TicketStatus.OPEN.value, nullable=False
    )
    priority: Mapped[str] = mapped_column(
        String(20), default=TicketPriority.NORMAL.value, nullable=False
    )

    # Two timestamps, not one, and they are not redundant.
    #
    # ``closed`` is reachable without ever passing through ``resolved``: a
    # duplicate, a ticket the employee withdraws, a request that stopped
    # mattering. With only ``resolved_at`` we would have to either stamp it on
    # a ticket that was never resolved -- which poisons mean-time-to-resolution,
    # the one number a helpdesk exists to move -- or lose the closing date
    # altogether. Both are worse than one extra nullable column.
    #
    # ``resolved_at`` is cleared on reopen, so it always means "when the fix
    # that currently stands was delivered", never "the first time someone
    # tried". ``closed_at`` is the only honest answer to "when did this end".
    resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Where this ticket was raised from, when it was raised from somewhere:
    # ``source_module`` is a module name ("regularization", "leave", "assets")
    # and ``source_ref`` is that module's row id.
    #
    # THE ABSENCE OF A FOREIGN KEY HERE IS THE POINT, NOT AN OVERSIGHT.
    #
    # The spec requires that any module can offer a "raise a ticket"
    # affordance while helpdesk itself depends on nothing. Those two are only
    # compatible if the back-link is untyped. The moment someone "tidies this
    # up" into a real FK to ``regularization_requests``, helpdesk stops being
    # buildable on its own, its migration grows an ordering dependency on every
    # module that ever links to it, and deleting a regularization row starts
    # cascading into a support ticket. Do not add a constraint here. If a
    # future reviewer flags the missing FK, this comment is the answer.
    #
    # Consequences that the read path must therefore handle, not treat as bugs:
    #
    # * A dangling ref is EXPECTED. The referenced row can be deleted, purged
    #   by a retention job, or belong to a module this deployment does not have
    #   enabled. Resolving a source link must render "linked item unavailable"
    #   and must never 500. The ticket is still a valid ticket without it.
    # * An unknown ``source_module`` string is expected for the same reason and
    #   takes the same path -- never a KeyError on a dispatch dict.
    # * The ref is a POINTER, NOT A GRANT. It says where the ticket came from;
    #   it says nothing about who may open the thing it points at. The target
    #   module authorises that itself, and a denial renders as the same
    #   "unavailable" as a dangling ref so the two are indistinguishable to the
    #   caller.
    source_module: Mapped[str | None] = mapped_column(String(40), nullable=True)
    source_ref: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)

    category: Mapped["HelpdeskCategory | None"] = relationship(back_populates="tickets")
    # Two FKs to the same table, so SQLAlchemy cannot infer either join.
    raiser: Mapped["User | None"] = relationship(foreign_keys="HelpdeskTicket.raised_by")
    assignee: Mapped["User | None"] = relationship(foreign_keys="HelpdeskTicket.assigned_to")
    # delete-orphan: a comment has no meaning without its ticket, and a ticket
    # is only ever hard-deleted deliberately.
    comments: Mapped[list["HelpdeskComment"]] = relationship(
        back_populates="ticket",
        cascade="all, delete-orphan",
        order_by="HelpdeskComment.created_at",
    )

    @property
    def status_enum(self) -> TicketStatus:
        try:
            return TicketStatus(self.status)
        except ValueError:
            return TicketStatus.CLOSED

    @property
    def priority_enum(self) -> TicketPriority:
        try:
            return TicketPriority(self.priority)
        except ValueError:
            return TicketPriority.NORMAL

    def comments_for(self, *, include_internal: bool) -> list["HelpdeskComment"]:
        """Comments for one audience. ``include_internal`` is never defaulted.

        The keyword-only argument is deliberately required: every call site has
        to state, in the line a reviewer reads, which audience it is building a
        response for. A default here would be the entire bug.
        """
        if include_internal:
            return list(self.comments)
        return [c for c in self.comments if not c.is_internal]


class HelpdeskComment(UUIDMixin, TimestampMixin, Base):
    """One message on a ticket thread -- a reply, or an HR-only internal note.

    ``is_internal`` is non-nullable and defaults to ``False`` because a reply is
    the common case, but **no write path may lean on that default**. An
    employee-authored comment cannot be internal at all (the employee request
    schema has no such field), and a staff-authored one has to state its
    audience explicitly -- see ``StaffCommentIn`` in ``app.schemas.helpdesk``.
    """

    __tablename__ = "helpdesk_comments"
    __table_args__ = (
        # The thread, in order. Every ticket-detail read hits this.
        Index("ix_helpdesk_comments_ticket_created", "ticket_id", "created_at"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # CASCADE, unlike every other FK here: a thread cannot outlive its ticket,
    # and orphaned internal notes floating in the table would be a disclosure
    # risk with no owner left to scope them to.
    ticket_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("helpdesk_tickets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # SET NULL: the content of an internal note *is* the audit trail, and it
    # has to survive the HR person who wrote it leaving. Losing the author
    # weakens attribution; deleting the note would destroy the record. An
    # unattributed note is still internal -- visibility is governed by
    # ``is_internal`` alone and never by who wrote it.
    author_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    # THE security boundary of this module. True = HR-only, permanently. Never
    # expose this row through a schema an employee-facing handler can return;
    # see the module docstring and ``app.schemas.helpdesk``.
    is_internal: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    ticket: Mapped["HelpdeskTicket"] = relationship(back_populates="comments")
    author: Mapped["User | None"] = relationship()
