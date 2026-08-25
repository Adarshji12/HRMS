"""One decision kernel, and the six flows that declare their rules to it.

Seven things in this system are approved by somebody: leave, timesheets,
attendance regularizations, expense claims, loans, performance reviews and the
exit settlement. The first six were written on their own, and by the time the
sixth arrived they had drifted in ways nobody chose:

* **The self-review guard lived in two different layers.** Leave and timesheets
  checked it in the router; regularization, expenses and loans checked it in the
  service. A rule enforced in the router is a rule that a second caller of the
  same service does not get.
* **The owner exemption was inconsistent** — exempt for timesheets and
  regularization, not for expenses and loans. That is a legitimate difference
  (somebody else signs off your spending, even if you own the company) but it
  was never written down anywhere the two could be compared.
* **Timesheet approval had no already-decided guard at all**, so approving one
  twice silently re-froze a different set of minutes over the first decision.
* **The reviewer column has two names** (``reviewed_by_user_id`` /
  ``reviewed_by``) and so does the note (``review_note`` / ``note``).

This module does not fix the column names — five renaming migrations to make
five services stop caring is a poor trade. It records them, once, in the policy
that describes each flow, so the drift is data in one table instead of knowledge
spread over five files.

What the kernel owns
--------------------

:func:`decide` owns exactly four things, and deliberately no more:

1. **Refusing a second decision.** A decided record is a record.
2. **Refusing self-review**, per the flow's declared policy.
3. **Requiring a reason on a rejection**, per the flow's declared policy — a
   rejection with no reason guarantees the identical request comes back
   tomorrow.
4. **Stamping and auditing** the decision identically everywhere.

Everything else stays in the flow's own service: what a sanctioned principal may
be, what a leave debit does, which attendance rows an approval rewrites. Those
are not workflow, they are the thing being approved.

**Side effects run before the stamp.** Leave's approval path documented why and
the ordering is now the kernel's contract: ``debit_for_application`` re-reads the
status from the database to detect a concurrent approval, and a flushed
"approved" would make the loser of that race think it had won. Every other
flow's side effect is indifferent to the order, so the one that is not decides
it.

**The kernel does not commit.** It flushes and writes the audit row; the caller
owns the transaction. Half the flows commit in the service and half in the
router, and a kernel that committed would take that choice away from both.

Audit actions are preserved too
-------------------------------

Each flow keeps the exact action string it already wrote — ``leave.decided``,
``expenses.reviewed``, and so on. Uniform-looking names would be nicer to read
and would split every company's existing audit log in half at the deploy
boundary. The outcome is in ``detail.decision``; the action says which flow.

Reason codes are preserved, not unified
---------------------------------------

The same condition — "this is not awaiting a decision" — is called
``already_decided`` by leave and regularization, ``not_submitted`` by expenses
and ``not_pending`` by loans. Performance, written after the kernel existed,
simply takes the default — which is what a seventh flow costs now. They stay as
they are: those strings are on the
wire, clients key on them, and renaming them to tidy up an internal refactor
would be breaking an API to make a table look neater. The policy carries the
code, which at least puts the three names in one place where the inconsistency
is visible.
"""

from __future__ import annotations

import enum
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Iterable

from fastapi import HTTPException, Request
from sqlalchemy.orm import Session

from app.api.deps import audit
from app.models import Role, User


class WorkflowError(HTTPException):
    """A typed refusal, in the house style every other module here uses.

    ``{"reason": <code>, "message": <sentence>}`` — so one client-side handler
    covers this and the five module-specific error classes it sits behind.
    """

    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(status_code, detail={"reason": code, "message": message})
        self.code = code


class SelfReview(str, enum.Enum):
    """Whether somebody may decide their own request.

    Three values because there are genuinely three answers in this codebase, and
    collapsing them would mean choosing one flow's rule for another flow.
    """

    #: Nobody, not even the owner. Somebody else signs off your spending.
    FORBIDDEN = "forbidden"
    #: The owner may. In a small company there may be nobody above them, and an
    #: owner who cannot approve their own leave cannot take leave.
    OWNER_MAY = "owner_may"
    #: No check. Reserved for a flow where the decider is structurally never the
    #: subject; nothing uses it today, and a flow that reaches for it should
    #: have to explain why in its policy.
    ALLOWED = "allowed"


@dataclass(frozen=True)
class Policy:
    """Everything the kernel needs to know about one approvable thing.

    Frozen and declared at import time: a policy that could be built per-call is
    a policy that can differ per-call, and "why was this approval allowed" would
    stop having a single answer.
    """

    #: Stable handle. Appears in the audit row and in the unified queue.
    kind: str
    #: What a human calls it. "leave request", "expense claim".
    label: str

    #: The status(es) that await a decision. A tuple because a flow may have
    #: more than one entry state; most have exactly one.
    pending: tuple[str, ...]
    approved: str
    rejected: str

    self_review: SelfReview
    #: Whether a rejection must carry a reason. True everywhere except leave,
    #: which has never required one — see the note in the module docstring
    #: about not changing behaviour while moving it.
    reason_on_reject: bool

    #: The exact audit action this flow writes, for **both** outcomes.
    #:
    #: Not split into ``.approved`` / ``.rejected``, tempting though it is. An
    #: audit log is a historical record: splitting it would leave a company's
    #: log with ``expenses.reviewed`` rows before this deploy and
    #: ``expenses.approved`` rows after, and no way to ask "every expense
    #: decision" without knowing the deploy date. The outcome is already in the
    #: row's ``detail.decision``.
    audit_action: str
    #: ``AuditLog.target_type``.
    target_type: str

    # --- the column drift, recorded rather than migrated away ---------------- #
    #: Column holding the deciding user. Two spellings exist in this codebase.
    reviewer_column: str = "reviewed_by_user_id"
    #: Column holding the reason. Two spellings exist.
    note_column: str = "review_note"
    #: Column identifying whose request it is, for the self-review check.
    subject_column: str = "user_id"

    #: Refusal code for "not awaiting a decision". Three different strings are
    #: already on the wire; see the module docstring.
    stale_code: str = "already_decided"

    #: Whether :func:`decide` may drive this flow.
    #:
    #: False for the settlement, and the reason is worth stating rather than
    #: quietly omitting it from the table: a settlement is not decided, it is
    #: *amended*, through an endpoint that also sets the paid date and the UTR.
    #: It has no ``reviewed_at`` and no rejection — an exit that is not settled
    #: is cancelled, not refused. Forcing it through the kernel would mean
    #: teaching the kernel a fourth column-name convention to serve one caller.
    #: It stays in the table because it belongs in the **queue**: a draft
    #: settlement really is waiting for somebody, and a "what is waiting for me"
    #: list that omitted it would be lying by omission.
    decidable: bool = True

    #: Set only where a flow's log **already** distinguished the two outcomes.
    #: Timesheets did; nothing else does. Preserving that is the same argument
    #: the module docstring makes, read the other way round: a company's
    #: timesheet log already splits, and collapsing it would break the queries
    #: that rely on the split.
    audit_action_rejected: str | None = None

    def action_for(self, approve: bool) -> str:
        if approve or self.audit_action_rejected is None:
            return self.audit_action
        return self.audit_action_rejected

    def is_pending(self, record: Any) -> bool:
        return getattr(record, "status", None) in self.pending


# --------------------------------------------------------------------------- #
# The six flows, side by side
# --------------------------------------------------------------------------- #
#
# This is the table the module exists for. Every difference below was already
# true; none of it was previously readable in one place.

LEAVE = Policy(
    kind="leave",
    label="leave request",
    pending=("pending",),
    approved="approved",
    rejected="rejected",
    # The owner may approve their own leave: in a two-person company nobody else
    # can, and an owner who cannot take leave is not a policy anybody chose.
    self_review=SelfReview.OWNER_MAY,
    # The one flow that has never required a reason. Left alone deliberately —
    # this refactor moves rules, it does not invent them. Worth revisiting.
    reason_on_reject=False,
    audit_action="leave.decided",
    target_type="leave_application",
    stale_code="already_decided",
)

TIMESHEET = Policy(
    kind="timesheet",
    label="timesheet",
    # Everything except `approved`. A timesheet has no explicit "awaiting a
    # decision" state — a manager may approve a draft period directly, which is
    # how most weeks are signed off — and a rejected one must be re-approvable
    # once the employee has corrected it. Only an approved one is closed, and
    # **that guard is new**: approving twice used to silently re-freeze a
    # different set of minutes over the first decision.
    pending=("draft", "submitted", "rejected"),
    approved="approved",
    rejected="rejected",
    self_review=SelfReview.OWNER_MAY,
    reason_on_reject=True,
    audit_action="timesheet.approved",
    audit_action_rejected="timesheet.rejected",
    target_type="timesheet",
    note_column="note",
    subject_column="user_id",
    stale_code="already_approved",
)

REGULARIZATION = Policy(
    kind="regularization",
    label="regularization request",
    pending=("pending",),
    approved="approved",
    rejected="rejected",
    self_review=SelfReview.OWNER_MAY,
    reason_on_reject=True,
    audit_action="regularization.decided",
    target_type="regularization_request",
    stale_code="already_decided",
)

EXPENSE = Policy(
    kind="expense",
    label="expense claim",
    pending=("submitted",),
    approved="approved",
    rejected="rejected",
    # Not even the owner. Somebody else signs off your spending, and unlike
    # leave there is always somebody who can: finance, or a second director.
    self_review=SelfReview.FORBIDDEN,
    reason_on_reject=True,
    audit_action="expenses.reviewed",
    target_type="expense_claim",
    reviewer_column="reviewed_by",
    stale_code="not_submitted",
)

LOAN = Policy(
    kind="loan",
    label="loan request",
    pending=("requested",),
    approved="approved",
    rejected="rejected",
    self_review=SelfReview.FORBIDDEN,
    reason_on_reject=True,
    audit_action="loans.reviewed",
    target_type="loan",
    reviewer_column="reviewed_by",
    stale_code="not_pending",
)

PERFORMANCE = Policy(
    kind="performance",
    label="performance review",
    # Only a submitted self-review. A draft is the employee still writing, and
    # a manager deciding on it would be deciding on half a sentence.
    pending=("self_submitted",),
    approved="manager_submitted",
    # Sent back to the employee, and `returned` is a real state rather than a
    # synonym for draft: somebody whose review comes back needs to know it was
    # looked at, and a silent return to draft looks like a lost submission.
    rejected="returned",
    # Not even the owner. An appraisal you write, rate and pass on yourself is
    # not an appraisal — and unlike leave there is always somebody else who can
    # do it, because HR runs the round.
    self_review=SelfReview.FORBIDDEN,
    reason_on_reject=True,
    audit_action="performance.decided",
    target_type="performance_review",
    reviewer_column="reviewed_by",
)

SETTLEMENT = Policy(
    kind="settlement",
    label="full and final settlement",
    pending=("draft",),
    approved="approved",
    # A settlement is not rejected; it is amended or the exit is cancelled.
    # Declared anyway so the shape is uniform, and unreachable in practice.
    rejected="cancelled",
    self_review=SelfReview.FORBIDDEN,
    reason_on_reject=True,
    decidable=False,
    audit_action="offboarding.fnf.approved",
    target_type="offboarding_fnf",
    reviewer_column="approved_by",
    note_column="notes",
    subject_column="",
    stale_code="not_draft",
)

#: Every policy, by kind. The unified approvals queue reads this rather than
#: keeping its own list, so a seventh flow appears there by existing. Note that
#: membership here is not the same as being decidable — see ``Policy.decidable``.
POLICIES: dict[str, Policy] = {
    p.kind: p
    for p in (LEAVE, TIMESHEET, REGULARIZATION, EXPENSE, LOAN, PERFORMANCE, SETTLEMENT)
}


# --------------------------------------------------------------------------- #
# The guards, individually callable
# --------------------------------------------------------------------------- #


def ensure_pending(policy: Policy, record: Any, *, what: str | None = None) -> None:
    """Refuse a second decision on a record that already has one."""
    if policy.is_pending(record):
        return
    status = getattr(record, "status", "in an unknown state")
    raise WorkflowError(
        policy.stale_code,
        f"This {what or policy.label} is {status}, not awaiting a decision.",
        409,
    )


def ensure_not_self(policy: Policy, record: Any, reviewer: User) -> None:
    """Refuse somebody deciding their own request, per the flow's policy.

    The owner exemption is a property of the flow, not of the role: an owner may
    approve their own leave and may not approve their own expense claim, and
    both of those are deliberate.
    """
    if policy.self_review is SelfReview.ALLOWED or not policy.subject_column:
        return
    subject_id = getattr(record, policy.subject_column, None)
    if subject_id != reviewer.id:
        return
    if policy.self_review is SelfReview.OWNER_MAY and reviewer.role_enum is Role.OWNER:
        return
    raise WorkflowError(
        "self_review",
        f"You cannot decide your own {policy.label}.",
        403,
    )


def ensure_reason(policy: Policy, *, approve: bool, note: str | None) -> str | None:
    """Require a reason on a rejection, and normalise the note either way.

    Returns the cleaned note, so a caller never has to remember that an empty
    string and ``None`` mean the same thing here.
    """
    cleaned = (note or "").strip() or None
    if approve or not policy.reason_on_reject or cleaned:
        return cleaned
    raise WorkflowError(
        "note_required",
        "Say why it is rejected — otherwise the same request comes back tomorrow.",
    )


# --------------------------------------------------------------------------- #
# The decision
# --------------------------------------------------------------------------- #


def decide(
    db: Session,
    *,
    policy: Policy,
    record: Any,
    reviewer: User,
    approve: bool,
    note: str | None = None,
    request: Request | None = None,
    on_approve: Callable[[], None] | None = None,
    on_reject: Callable[[], None] | None = None,
    detail: dict | None = None,
    status_override: str | None = None,
    what: str | None = None,
) -> Any:
    """Guard, run the side effect, stamp, audit. Does not commit.

    ``on_approve`` runs **before** the record is stamped — see the module
    docstring on why the ordering is the kernel's contract rather than each
    flow's preference. It may raise: a side effect that fails must leave the
    record undecided, not decided-and-broken.

    ``status_override`` exists for the one flow whose approved state is not the
    policy's — nothing uses it yet, and a flow reaching for it should say why.
    """
    if not policy.decidable:
        # Not a refusal a user can trigger — a programming error, raised loudly
        # so it surfaces in a test rather than half-writing a settlement.
        raise RuntimeError(
            f"{policy.kind} is not driven by workflow.decide — see its policy."
        )
    ensure_pending(policy, record, what=what)
    ensure_not_self(policy, record, reviewer)
    cleaned = ensure_reason(policy, approve=approve, note=note)

    if approve and on_approve is not None:
        on_approve()
    if not approve and on_reject is not None:
        on_reject()

    record.status = status_override or (policy.approved if approve else policy.rejected)
    record.reviewed_at = datetime.now(timezone.utc)
    setattr(record, policy.reviewer_column, reviewer.id)
    setattr(record, policy.note_column, cleaned)
    db.flush()

    subject = (
        getattr(record, policy.subject_column, None) if policy.subject_column else None
    )
    audit(
        db,
        org_id=reviewer.org_id,
        actor=reviewer,
        action=policy.action_for(approve),
        request=request,
        target_type=policy.target_type,
        target_id=str(record.id),
        detail={
            **({"for": str(subject)} if subject else {}),
            "decision": record.status,
            "note": cleaned,
            **(detail or {}),
        },
    )
    return record
