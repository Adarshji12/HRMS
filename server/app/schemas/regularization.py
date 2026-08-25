"""Request/response shapes for attendance regularization.

The one thing to get right here: no request body carries an identity.
``RegularizationIn`` has no ``user_id`` and no ``created_by_user_id``;
``RegularizationReviewIn`` has no ``reviewed_by``. All three are taken from the
authenticated caller in the router. Accepting any of them from the body would
let an employee file a request in a colleague's name, forge who authored one, or
sign a decision as somebody else — which is precisely the attribution hole this
whole feature exists to close.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field, model_validator

from app.schemas.common import ORMModel


class RegularizationIn(BaseModel):
    """An employee asking for one attendance day to be corrected."""

    date: date
    # Optional independently: the usual request is a forgotten check-out, and
    # forcing a check-in would make the employee restate a punch that is
    # already correct — which approval would then write back over the real one.
    requested_check_in: datetime | None = None
    requested_check_out: datetime | None = None
    # Deliberately absent: created_by_user_id. Authorship is a claim about the
    # caller, and a caller is not a trustworthy source of claims about itself
    # — the router sets it from the authenticated identity, always. This is
    # the same argument as user_id, and it holds even more strongly here,
    # because a forged author is the one field that would make the audit trail
    # actively misleading rather than merely incomplete.
    # Required and non-blank. A manager approving a change to someone's
    # attendance record with no stated reason produces an audit row that
    # cannot answer the only question ever asked of it.
    reason: str = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def _must_request_something(self) -> "RegularizationIn":
        # Mirrors the ck_regularization_requests_has_requested_time constraint,
        # so this surfaces as a 422 with a readable message instead of a 500
        # from the database driver.
        # min_length=1 alone happily accepts "   ", which stores a NOT NULL
        # reason that tells the manager nothing — the exact outcome the
        # non-nullable column was meant to prevent.
        self.reason = self.reason.strip()
        if not self.reason:
            raise ValueError("reason must not be blank")
        if self.requested_check_in is None and self.requested_check_out is None:
            raise ValueError(
                "at least one of requested_check_in or requested_check_out is required"
            )
        if (
            self.requested_check_in is not None
            and self.requested_check_out is not None
            and self.requested_check_out <= self.requested_check_in
        ):
            # Not merely tidiness: approval derives worked_minutes from this
            # pair, and a reversed pair yields negative worked time that then
            # propagates into every attendance report for the period.
            raise ValueError("requested_check_out must be after requested_check_in")
        return self


class RegularizationReviewIn(BaseModel):
    """A manager's decision on one request.

    Approve/reject only — ``pending`` is not an accepted input, because
    "un-deciding" a request is not a decision, it is an erasure of one. If that
    is ever genuinely needed it should be a new request, not a status rewind.
    """

    status: str = Field(pattern=r"^(approved|rejected)$")
    # Optional on approval, but the service should insist on it for a
    # rejection: telling someone no without telling them why guarantees the
    # identical request comes back tomorrow.
    review_note: str | None = Field(default=None, max_length=2000)


class RegularizationOut(ORMModel):
    id: uuid.UUID
    org_id: uuid.UUID
    user_id: uuid.UUID
    date: date
    requested_check_in: datetime | None = None
    requested_check_out: datetime | None = None
    reason: str
    status: str
    created_by_user_id: uuid.UUID | None = None
    reviewed_by_user_id: uuid.UUID | None = None
    reviewed_at: datetime | None = None
    review_note: str | None = None
    created_at: datetime

    # Derived, so the manager queue renders from one query and never joins on
    # the client. reviewer_name stays None on a pending row, and also on a
    # decided row whose reviewer has since been deleted — reviewed_at is then
    # the surviving proof that a decision was made, which is why the queue
    # should render the timestamp rather than only the name.
    #
    # created_by_name is None only when the author's user row is gone; a
    # self-filed request repeats the employee's own name, because
    # created_by_user_id stores the employee's id rather than NULL. The queue
    # should therefore show authorship only when created_by_user_id !=
    # user_id, or every ordinary row grows a redundant "filed by" line.
    user_name: str | None = None
    reviewer_name: str | None = None
    created_by_name: str | None = None
