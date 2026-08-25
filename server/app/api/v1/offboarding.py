"""Employee exits: requests, the clearance checklist, and the F&F stub.

Thin by design — every rule lives in ``app.services.offboarding``, and a
handler here that grows a business rule is a review failure. In this module it
would also be how a second device-revoke path gets written, so the discipline
is load-bearing rather than stylistic.

**One gate, on the whole router.** Everything below is an HR administrator's
screen: an exit record carries the reason somebody was terminated, their
manager's handover notes, and the last money the company owes them. There is no
employee-facing half to split off the way ``assets.py`` splits ``/assets/my``,
so the dependency is declared once on the ``APIRouter`` instead of repeated on
fourteen handlers, where the fifteenth would eventually be added without it.

The per-person flag is ``can_manage_onboarding`` — the employee-lifecycle flag
— and not a new ``can_manage_offboarding``. Adding one means a column on
``users``, which is a lead-owned model and a migration, for a distinction no
customer has asked for: the people who run joiners run leavers. If that turns
out to be wrong the flag can be split later without moving any of these routes.
Like every flag in this product it only ever restricts (see the note on the
columns in ``app.models.user``), so it cannot grant anybody anything the
``AdminUser`` role check already refused.

**Completion is its own endpoint, not a PATCH.** ``OffboardingRequestUpdate``
deliberately cannot express ``status``: completing an exit revokes devices and
deactivates a person, and that must be a thing somebody meant to do rather than
a field that arrived in an edit body.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, Request, status

from app.api.deps import AdminUser, DbSession, deny_unless
from app.models import User
from app.schemas.assets import AssetOut, AssetReturnIn
from app.schemas.settlement import ProposalOut, ProposedLineOut
from app.schemas.offboarding import (
    OffboardingCancelIn,
    OffboardingDetailOut,
    OffboardingFnfIn,
    OffboardingFnfOut,
    OffboardingFnfUpdate,
    OffboardingRequestIn,
    OffboardingRequestOut,
    OffboardingRequestUpdate,
    OffboardingTaskIn,
    OffboardingTaskOut,
    OffboardingTaskUpdate,
)
from app.services import offboarding as svc
from app.services import settlement as settlement_svc

_MANAGE = "manage employee onboarding and offboarding"


def require_offboarding_admin(admin: AdminUser) -> User:
    """Administrator role first, then the per-person flag. Order is the model.

    Composed exactly like ``require_approver`` and ``require_helpdesk_staff``:
    the role check has already run by the time ``deny_unless`` is called, so a
    flag left on can never widen anybody's reach.
    """
    deny_unless(admin, "can_manage_onboarding", _MANAGE)
    return admin


router = APIRouter(
    prefix="/offboarding",
    tags=["offboarding"],
    dependencies=[Depends(require_offboarding_admin)],
)

#: Declared as a parameter as well as a router dependency. The router-level
#: dependency is what *enforces* the gate on every route including ones added
#: later; this is how a handler gets the caller object to pass as ``actor``.
#: They cannot drift, because the enforcement does not come from this one.
HrAdmin = AdminUser


class AssetReturnForTaskIn(AssetReturnIn):
    """An asset return raised from a clearance item.

    Extends the Assets payload rather than redefining it so the two can never
    disagree about what a return means — ``resulting_status`` in particular,
    which is how a laptop handed back with a cracked screen reaches the repair
    queue instead of the next joiner's desk.
    """

    asset_id: uuid.UUID


# --------------------------------------------------------------------------- #
# Exit requests
# --------------------------------------------------------------------------- #


@router.get("/requests", response_model=list[OffboardingRequestOut])
def list_requests(
    admin: HrAdmin,
    db: DbSession,
    status_filter: str | None = Query(default=None, alias="status"),
    user_id: uuid.UUID | None = None,
    open_only: bool = False,
) -> list[OffboardingRequestOut]:
    # Aliased because `status` is also the FastAPI status-code module imported
    # above; same shape assets.py and projects.py use for the same collision.
    return svc.list_requests(
        db, admin.org_id, status_filter=status_filter, user_id=user_id, open_only=open_only
    )


@router.post(
    "/requests", response_model=OffboardingDetailOut, status_code=status.HTTP_201_CREATED
)
def initiate(
    payload: OffboardingRequestIn, admin: HrAdmin, db: DbSession, request: Request
) -> OffboardingDetailOut:
    """Open an exit. The clearance checklist is created with it, never after.

    Returning the detail shape rather than the list row: the caller's next
    screen is the checklist that was just laid out, and a second round-trip to
    fetch it is a round-trip that can fail after the exit already exists.
    """
    return svc.initiate(db, admin.org_id, payload, actor=admin, request=request)


@router.get("/requests/{request_id}", response_model=OffboardingDetailOut)
def get_request(
    request_id: uuid.UUID, admin: HrAdmin, db: DbSession
) -> OffboardingDetailOut:
    return svc.detail(db, admin.org_id, request_id)


@router.patch("/requests/{request_id}", response_model=OffboardingDetailOut)
def update_request(
    request_id: uuid.UUID,
    payload: OffboardingRequestUpdate,
    admin: HrAdmin,
    db: DbSession,
    request: Request,
) -> OffboardingDetailOut:
    """Edit an in-flight exit.

    Moving ``last_working_day`` recomputes every clearance due date from its
    offset (D-023) — which is why the response is the full detail shape: the
    dates on the caller's screen have all just changed.
    """
    return svc.update_request(db, admin.org_id, request_id, payload, actor=admin, request=request)


@router.post("/requests/{request_id}/cancel", response_model=OffboardingDetailOut)
def cancel_request(
    request_id: uuid.UUID,
    payload: OffboardingCancelIn,
    admin: HrAdmin,
    db: DbSession,
    request: Request,
) -> OffboardingDetailOut:
    """Withdraw an exit. Not a DELETE, because the row is not going away.

    A withdrawn resignation is history somebody may need later, and the verb
    matters: DELETE would tell every reader of this table that cancelling
    destroys the record.
    """
    return svc.cancel_request(db, admin.org_id, request_id, payload, actor=admin, request=request)


@router.post("/requests/{request_id}/complete", response_model=OffboardingDetailOut)
def complete_request(
    request_id: uuid.UUID, admin: HrAdmin, db: DbSession, request: Request
) -> OffboardingDetailOut:
    """Close the exit: revoke devices, deactivate the account, stamp the record.

    Refused with a typed ``{reason, message, blocking_tasks}`` body while any
    mandatory clearance item is unsettled, so the console can name the items
    rather than rendering a bare 409. The revoke reuses the existing
    ``devices.is_active`` path — see the service.
    """
    return svc.complete(db, admin.org_id, request_id, actor=admin, request=request)


# --------------------------------------------------------------------------- #
# Clearance tasks
# --------------------------------------------------------------------------- #


@router.post(
    "/requests/{request_id}/tasks",
    response_model=OffboardingTaskOut,
    status_code=status.HTTP_201_CREATED,
)
def add_task(
    request_id: uuid.UUID,
    payload: OffboardingTaskIn,
    admin: HrAdmin,
    db: DbSession,
    request: Request,
) -> OffboardingTaskOut:
    return svc.add_task(db, admin.org_id, request_id, payload, actor=admin, request=request)


@router.patch("/requests/{request_id}/tasks/{task_id}", response_model=OffboardingTaskOut)
def update_task(
    request_id: uuid.UUID,
    task_id: uuid.UUID,
    payload: OffboardingTaskUpdate,
    admin: HrAdmin,
    db: DbSession,
    request: Request,
) -> OffboardingTaskOut:
    """Tick an item off, reassign it, or waive it with a reason.

    Nested under the exit rather than exposed as ``/tasks/{id}``: the service
    checks the task against *its* request, so one exit's URL cannot be used to
    edit another's checklist, and a flat route would make that check look
    optional.
    """
    return svc.update_task(
        db, admin.org_id, request_id, task_id, payload, actor=admin, request=request
    )


@router.delete(
    "/requests/{request_id}/tasks/{task_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    # Explicit: without it FastAPI infers NoneType from `-> None` and rejects a
    # 204 route as "must not have a response body".
    response_model=None,
)
def delete_task(
    request_id: uuid.UUID,
    task_id: uuid.UUID,
    admin: HrAdmin,
    db: DbSession,
    request: Request,
) -> None:
    svc.delete_task(db, admin.org_id, request_id, task_id, actor=admin, request=request)


# --------------------------------------------------------------------------- #
# it_asset_return — the hook into the asset register
# --------------------------------------------------------------------------- #


@router.get("/requests/{request_id}/assets", response_model=list[AssetOut])
def outstanding_assets(
    request_id: uuid.UUID, admin: HrAdmin, db: DbSession
) -> list[AssetOut]:
    """What the leaver is still holding, read straight from the register."""
    return svc.outstanding_assets(db, admin.org_id, request_id)


@router.post(
    "/requests/{request_id}/tasks/{task_id}/return-asset", response_model=OffboardingTaskOut
)
def return_asset_for_task(
    request_id: uuid.UUID,
    task_id: uuid.UUID,
    payload: AssetReturnForTaskIn,
    admin: HrAdmin,
    db: DbSession,
    request: Request,
) -> OffboardingTaskOut:
    """Take an asset back and settle the clearance item in one call.

    The custody write is ``services.assets.return_asset`` — the same function
    ``POST /assets/{id}/return`` calls. This route exists so IT does not have to
    leave the exit screen, not so offboarding can own custody: the register
    stays fully usable in an org that never runs an exit checklist, and the
    dependency runs one way only.
    """
    return svc.return_asset_for_task(
        db,
        admin.org_id,
        request_id,
        task_id,
        payload.asset_id,
        AssetReturnIn(
            returned_at=payload.returned_at,
            returned_condition_note=payload.returned_condition_note,
            resulting_status=payload.resulting_status,
        ),
        actor=admin,
        request=request,
    )


# --------------------------------------------------------------------------- #
# Full-and-final settlement
# --------------------------------------------------------------------------- #


@router.post(
    "/requests/{request_id}/fnf",
    response_model=OffboardingFnfOut,
    status_code=status.HTTP_201_CREATED,
)
def create_fnf(
    request_id: uuid.UUID,
    payload: OffboardingFnfIn,
    admin: HrAdmin,
    db: DbSession,
    request: Request,
) -> OffboardingFnfOut:
    """Record a settlement worked out somewhere else.

    Still here, and still the right endpoint for a settlement HR calculated in a
    spreadsheet or negotiated a figure for. ``POST .../settlement/accept`` is
    the computed route; this one takes three numbers on trust.

    ``net_payable_paise`` is stored as given and is never derived from gross
    minus deductions — the response carries ``is_consistent`` so the console can
    warn about a mismatch, and a mismatch is legitimate often enough (ex-gratia,
    negotiated write-offs) that refusing one would block real settlements.
    """
    return svc.create_fnf(db, admin.org_id, request_id, payload, actor=admin, request=request)


@router.patch("/requests/{request_id}/fnf", response_model=OffboardingFnfOut)
def update_fnf(
    request_id: uuid.UUID,
    payload: OffboardingFnfUpdate,
    admin: HrAdmin,
    db: DbSession,
    request: Request,
) -> OffboardingFnfOut:
    """Amend the settlement, or mark it approved or paid.

    Keyed on the request rather than the settlement id: there is exactly one
    per exit (``uq_offboarding_fnf_request_id``), so making the caller look up
    a second id would be asking them to answer a question the schema already
    answers. Every edit writes an ``AuditLog`` row — this table has no
    ``updated_at`` and the audit trail is the only thing that says the number
    changed (D-018).
    """
    return svc.update_fnf(db, admin.org_id, request_id, payload, actor=admin, request=request)

# --------------------------------------------------------------------------- #
# The computed settlement
# --------------------------------------------------------------------------- #
#
# Separate from the two routes above on purpose. Those record a figure; these
# work one out, and they need a capability the rest of this router does not —
# a settlement discloses salary, leave balance and loans, so `settlement_svc`
# checks the payroll permission on top of this router's HR-admin gate.


@router.get("/requests/{request_id}/settlement/proposal", response_model=ProposalOut)
def settlement_proposal(
    request_id: uuid.UUID,
    admin: HrAdmin,
    db: DbSession,
) -> ProposalOut:
    """Compute a settlement from live data. Writes nothing.

    A GET because it is a read — of the salary structure, leave balances, open
    loans and unpaid claims as they stand right now. Calling it twice a minute
    apart can legitimately give two different answers, which is why
    ``accept`` recomputes rather than taking the figures back from the client.

    Read ``warnings``. It is never empty: income tax on a settlement is not
    computed here, and the last entry always says so.
    """
    proposal = settlement_svc.propose(db, admin, request_id)
    return ProposalOut(
        request_id=proposal.request_id,
        user_id=proposal.user_id,
        user_name=proposal.user_name,
        last_working_day=proposal.last_working_day,
        lines=[
            ProposedLineOut(
                kind=line.kind.value, code=line.code, label=line.label,
                amount_paise=line.amount, source=line.source.value,
                source_id=line.source_id, detail=line.detail,
            )
            for line in proposal.lines
        ],
        gross_dues_paise=proposal.gross_dues,
        deductions_paise=proposal.deductions,
        net_payable_paise=proposal.net_payable,
        warnings=proposal.warnings,
        tax_paid_ytd=proposal.tax_paid_ytd,
        tax_deducted_ytd=proposal.tax_deducted_ytd,
        currency=proposal.currency,
    )


@router.post("/requests/{request_id}/settlement/accept", response_model=OffboardingFnfOut)
def accept_settlement(
    request_id: uuid.UUID,
    admin: HrAdmin,
    db: DbSession,
    request: Request,
) -> OffboardingFnfOut:
    """Write a freshly computed proposal onto the exit's settlement record.

    Takes no body. The figures are recomputed here rather than sent up, because
    a proposal the browser has been holding since before a claim was reimbursed
    is a proposal that is no longer true, and the stored settlement has to be
    one the numbers were correct for.

    Leaves the settlement in **draft** — approving it is somebody's decision and
    stays the separate PATCH it already was. Re-accepting replaces the lines;
    once the settlement is approved or paid it refuses.
    """
    fnf = settlement_svc.accept(db, admin, request_id, request=request)
    return svc.fnf_out(db, admin.org_id, fnf)

