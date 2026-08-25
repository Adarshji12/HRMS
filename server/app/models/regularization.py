"""Attendance regularization: an employee's request to correct their own day.

An employee **cannot edit ``attendance_records`` directly**. This is the same
rule timesheets already enforce: a human decision must never be silently
overwritten by the person it was made about (``ARCHITECTURE.md`` §5, the
``attribution`` service). A punch is evidence — of when someone was at a desk,
at an office, on a client site — and evidence its own subject can rewrite is not
evidence. So the employee files a *request* here, a manager decides it, and only
the approval path writes back to ``attendance_records`` (stamping
``check_in_source = 'regularized'``). A rejection leaves the original row
untouched, and the rejected request survives as the record that someone asked
and was told no.

Two decisions a reader would otherwise get wrong:

*Why this defines its own status enum instead of reusing
``timesheet.ApprovalStatus``.* That enum's state set is ``draft / submitted /
approved / rejected``. A regularization request has no draft state — it exists
from the moment it is submitted — and the state after submission is called
"pending" by the spec, the API and the manager queue alike. Reuse would mean
either persisting ``"submitted"`` under a UI that reads "pending", or admitting
``"draft"`` as a legal value every service then has to defend against. An enum's
value *is* its set of legal states; borrowing one whose states are wrong is not
reuse, it is aliasing. It would also couple us to a foreign lifecycle: the day
timesheets grow a ``RECALLED`` state, regularization silently inherits a state
it has no code for.

*Why "one pending request per day" is a database constraint and not a service
check.* See the partial unique index below.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date, datetime

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDMixin


class RegularizationStatus(str, enum.Enum):
    """Lifecycle of one regularization request.

    Deliberately three states, not four — see the module docstring for why this
    does not reuse ``timesheet.ApprovalStatus``.
    """

    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"

    @property
    def is_decided(self) -> bool:
        """Whether a manager has already ruled on this request.

        Guards the review endpoint: a decided request must not be decided a
        second time, or the second decision overwrites the first with nothing
        left to show the first was ever made.
        """
        return self in (RegularizationStatus.APPROVED, RegularizationStatus.REJECTED)


class RegularizationRequest(UUIDMixin, TimestampMixin, Base):
    """One employee's request to correct one attendance day."""

    __tablename__ = "regularization_requests"
    __table_args__ = (
        # At most one *pending* request per person per day, enforced by the
        # database rather than by a read-then-write in the service.
        #
        # A plain UniqueConstraint(org_id, user_id, date) would be wrong: it
        # forbids a second request after the first was rejected, which is
        # exactly the case the feature exists for — the employee explains
        # themselves badly, gets a no, and asks again with the real reason. It
        # equally forbids correcting an already-approved day, and it makes the
        # audit history destroy itself, because the only way to file again
        # would be to delete the decision already on record.
        #
        # Scoping the uniqueness to status='pending' keeps the entire
        # approved/rejected history for a date while making a duplicate *open*
        # request impossible. That has to be a constraint, not a service check:
        # a service check is a read followed by a write, and two double-clicked
        # submits interleave through it happily, putting two identical rows in
        # the manager's queue. The manager approves both, and the second write
        # silently overwrites the first — an unattributable attendance edit,
        # which is the single failure this whole table exists to prevent.
        #
        # Cost of the choice: it is a partial index, so both dialects need the
        # predicate spelled out, and Alembic autogenerate does not reliably
        # emit the WHERE clause — the generated migration must be read and
        # corrected by hand. That is a one-time cost paid by one person,
        # against a race reproducible on any slow network.
        Index(
            "uq_regularization_pending_day",
            "org_id",
            "user_id",
            "date",
            unique=True,
            sqlite_where=text("status = 'pending'"),
            postgresql_where=text("status = 'pending'"),
        ),
        # The manager queue is "everything still pending in my org, oldest
        # first". Status alone has almost no cardinality, so the composite is
        # what makes that query cheap.
        Index("ix_regularization_org_status_date", "org_id", "status", "date"),
        # The employee's own history for a date, and the lookup the approval
        # path performs before it touches attendance_records.
        Index("ix_regularization_user_day", "user_id", "date"),
        # A request asking for neither a check-in nor a check-out has nothing
        # for the approval path to apply, so it is not a request at all.
        # Enforced in the database and not only in Pydantic, because the
        # seeder and any future bulk-import job bypass the schemas entirely.
        CheckConstraint(
            "requested_check_in IS NOT NULL OR requested_check_out IS NOT NULL",
            # The metadata naming convention expands this to
            # ck_regularization_requests_has_requested_time.
            name="has_requested_time",
        ),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # The attendance day being corrected, in the org's timezone — never a UTC
    # midnight. Same Date-not-DateTime discipline as attendance_records.date
    # and TimeEntry.entry_date, so joining the two is an equality test rather
    # than a timezone-shifted range on every manager-queue query.
    date: Mapped[date] = mapped_column(Date, nullable=False)

    # Nullable independently, for the same reason attendance_records makes the
    # punches nullable: the common request is a missed check-out, not a missing
    # day. Requiring both would make the employee invent a check-in time that
    # was already recorded correctly, and approval would then write that
    # invention over a real punch.
    requested_check_in: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    requested_check_out: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Not nullable. The reason is the whole justification a manager is being
    # asked to act on; an approvals trail whose rows say nothing about why is
    # an audit log that cannot answer the only question ever asked of it.
    reason: Mapped[str] = mapped_column(Text, nullable=False)

    # Who filed it, following the TimeEntry.created_by_user_id precedent: HR or
    # a manager filing on someone's behalf is legitimate and must be visible,
    # so authorship is never assumed to equal user_id. The subject of the
    # record and its author are separate facts, and an approval trail that
    # conflates them cannot answer "who asked for this change?".
    #
    # A self-filed request stores the employee's own id — it does NOT store
    # NULL. That matters because SET NULL below already claims NULL for a
    # different meaning: "the author's user row is gone". Overloading NULL to
    # also mean "self-filed" would make a request filed by a departed HR admin
    # read, forever after, as one the employee filed themselves — a false
    # attribution, which is worse than an absent one. So NULL here means
    # exactly one thing, and self-filing reads as created_by_user_id ==
    # user_id, which is the common case and is true rather than implied.
    #
    # SET NULL for the same reason as reviewed_by_user_id: the author leaving
    # the company must degrade the audit trail, never delete the request. The
    # column is nullable because SET NULL requires it to be, not because the
    # service may skip populating it — the router always sets it.
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    # No index=True here, unlike TimesheetApproval.status. Every query that
    # filters on status is org-scoped — this is a multi-tenant table and there
    # is no such thing as "all pending requests everywhere" — so
    # ix_regularization_org_status_date already serves them. A second
    # single-column index would only add write cost on a table that is written
    # on every submit and every decision.
    status: Mapped[str] = mapped_column(
        String(16), default=RegularizationStatus.PENDING.value, nullable=False
    )

    # SET NULL, not CASCADE. A reviewer leaving the company must not delete the
    # record of the decision they made — an approved attendance correction has
    # to stay explainable for as long as the payroll run it fed. Losing the
    # reviewer's name is a degraded audit trail; losing the row is no audit
    # trail at all, and it would additionally resurrect the day as
    # regularizable when it had already been decided.
    reviewed_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)

    @property
    def status_enum(self) -> RegularizationStatus:
        # Mirrors TimesheetApproval.status_enum: the column is a plain String,
        # so a value written by an older build or a hand-run SQL fix must not
        # raise on read.
        try:
            return RegularizationStatus(self.status)
        except ValueError:
            return RegularizationStatus.PENDING

    @property
    def is_decided(self) -> bool:
        return self.status_enum.is_decided
