"""Asset register and custody lifecycle.

Owns two things: the register (``assets``) and the custody ledger
(``asset_assignments``). Everything a handler needs — assign, return, history,
the employee's own list — is a function here; ``api/v1/assets.py`` only maps
HTTP onto these.

**The one design decision a reader would otherwise get wrong.** The database
guarantees exactly one thing: at most one *open* assignment per asset, via the
partial unique index ``uq_asset_assignments_open_per_asset``. It guarantees
nothing about ``assets.status``. That ``status == 'assigned'`` **iff an open
assignment exists** is a cross-table implication no constraint in this schema
can express, so it is service-layer discipline and nothing else: every function
here that opens or closes a custody row moves ``Asset.status`` in the *same
transaction*, and commits once. That is also why these functions commit rather
than leaving it to the handler, which is a deliberate departure from the
``projects.py`` flush-here-commit-there shape — the invariant must not depend on
a future handler remembering to call ``db.commit()`` after calling
``assign_asset``. If the ledger write is rejected by the partial index, the
status change is rolled back with it; a half-applied assign is what would leave
the register lying about who holds a machine, and answering that question is
the register's entire purpose.

**Backdated custody periods are checked here, because the database accepts
them.** The partial index constrains *open* rows only, so nothing stops two
closed periods for one asset from overlapping — insert a handover backdated to
last month on an asset that was demonstrably with someone else last month and
SQLite takes it happily. ``assign_asset`` therefore refuses a backdated
``assigned_at`` that falls inside a period already closed on that asset, and
``return_asset`` refuses a ``returned_at`` earlier than its own ``assigned_at``.
This is a best-effort check, not a guarantee, and saying so is the point of
this paragraph: it is a read-then-write, so two administrators backdating the
same asset concurrently can still interleave through it. That residual race is
accepted rather than papered over — backdating is a rare manual correction by
an administrator, not a contended path, and the constraint that would close it
(range exclusion) does not exist on SQLite.

Nothing here imports onboarding or offboarding. Those two drive assets from
outside — their ``it_setup`` and ``it_asset_return`` task categories are string
literals in *their* modules — so the Assets page is fully usable in an org that
adopts neither checklist. Do not add an import in this direction; it would make
the register depend on features it is meant to outlive.
"""

from __future__ import annotations

import calendar
import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import HTTPException, Request
from fastapi import status as http_status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import audit
from app.models import (
    Asset,
    AssetAssignment,
    AssetRenewal,
    AssetStatus,
    RenewalCycle,
    User,
)
from app.schemas.assets import (
    AssetAssignmentIn,
    AssetAssignmentOut,
    AssetDashboardOut,
    AssetIn,
    AssetOut,
    AssetRenewalOut,
    AssetRenewIn,
    AssetReturnIn,
    CountRow,
    HolderRow,
    MyAssetOut,
)

# A renewal further out than this is "ok"; inside it but outside the asset's
# own reminder window it is "upcoming".
UPCOMING_WINDOW_DAYS = 90
WARRANTY_WINDOW_DAYS = 30


def _aware(value: datetime) -> datetime:
    """Read a timestamp back as UTC-aware.

    SQLite hands back naive datetimes even for ``DateTime(timezone=True)``, and
    comparing one of those against ``datetime.now(timezone.utc)`` raises
    TypeError rather than returning a wrong answer — which means the overlap
    checks below would 500 instead of rejecting. Same normalisation
    ``services/reports.py`` and ``models/billing.py`` already do at their own
    comparison points.
    """
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


# --------------------------------------------------------------------------- #
# Lookups
# --------------------------------------------------------------------------- #


def get_asset(db: Session, org_id: uuid.UUID, asset_id: uuid.UUID) -> Asset:
    """The asset, or 404 — never another tenant's asset.

    404 rather than 403 on the cross-tenant miss, matching ``_get_project``: a
    403 would confirm the id exists somewhere, which is itself a leak across a
    tenant boundary.
    """
    asset = db.get(Asset, asset_id)
    if asset is None or asset.org_id != org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Asset not found")
    return asset


def open_assignment(
    db: Session, org_id: uuid.UUID, asset_id: uuid.UUID
) -> AssetAssignment | None:
    """The one open custody row for an asset, if any.

    Queried rather than read off ``Asset.current_assignment``, because that
    property walks the loaded collection and would fetch the asset's entire
    history to find one row.
    """
    return db.scalar(
        select(AssetAssignment).where(
            AssetAssignment.org_id == org_id,
            AssetAssignment.asset_id == asset_id,
            AssetAssignment.returned_at.is_(None),
        )
    )


def _open_rows_by_asset(
    db: Session, org_id: uuid.UUID, asset_ids: list[uuid.UUID]
) -> dict[uuid.UUID, tuple[AssetAssignment, str | None]]:
    """Open assignment plus holder name for a page of assets, in one query.

    The register's default view is the whole list, so resolving the holder per
    row would be one query per asset and another per name.
    """
    if not asset_ids:
        return {}
    rows = db.execute(
        select(AssetAssignment, User.full_name)
        .join(User, User.id == AssetAssignment.user_id)
        .where(
            AssetAssignment.org_id == org_id,
            AssetAssignment.asset_id.in_(asset_ids),
            AssetAssignment.returned_at.is_(None),
        )
    ).all()
    return {row[0].asset_id: (row[0], row[1]) for row in rows}


# --------------------------------------------------------------------------- #
# Serialisation
# --------------------------------------------------------------------------- #


def _today() -> date:
    return datetime.now(timezone.utc).date()


def renewal_state(asset: Asset, today: date | None = None) -> tuple[str, int | None]:
    """``(state, days_to_due)`` for an asset's next renewal.

    A retired asset is never due: it has been written off, and nagging about
    renewing something nobody uses is how a dashboard teaches people to ignore it.
    """
    if asset.renewal_date is None or asset.status_enum is AssetStatus.RETIRED:
        return "none", None
    days = (asset.renewal_date - (today or _today())).days
    if days < 0:
        return "overdue", days
    if days <= (asset.reminder_days or 0):
        return "due", days
    if days <= UPCOMING_WINDOW_DAYS:
        return "upcoming", days
    return "ok", days


def warranty_state(asset: Asset, today: date | None = None) -> str:
    if asset.warranty_expiry is None or asset.status_enum is AssetStatus.RETIRED:
        return "none"
    days = (asset.warranty_expiry - (today or _today())).days
    if days < 0:
        return "expired"
    if days <= WARRANTY_WINDOW_DAYS:
        return "expiring"
    return "ok"


def add_months(value: date, months: int) -> date:
    """Calendar-month arithmetic, clamped: 31 Jan + 1 month is 28/29 Feb."""
    total = value.month - 1 + months
    year, month = value.year + total // 12, total % 12 + 1
    return date(year, month, min(value.day, calendar.monthrange(year, month)[1]))


def _asset_out(asset: Asset, held: tuple[AssetAssignment, str | None] | None) -> AssetOut:
    row, holder_name = held if held else (None, None)
    state, days = renewal_state(asset)
    return AssetOut(
        id=asset.id,
        asset_tag=asset.asset_tag,
        category=asset.category,
        serial_number=asset.serial_number,
        purchase_date=asset.purchase_date,
        status=asset.status,
        created_at=asset.created_at,
        name=asset.name,
        brand=asset.brand,
        model_name=asset.model_name,
        vendor=asset.vendor,
        invoice_number=asset.invoice_number,
        purchase_cost_paise=asset.purchase_cost_paise,
        location=asset.location,
        warranty_expiry=asset.warranty_expiry,
        renewal_date=asset.renewal_date,
        renewal_cycle=asset.renewal_cycle or "none",
        renewal_cost_paise=asset.renewal_cost_paise,
        reminder_days=asset.reminder_days if asset.reminder_days is not None else 30,
        auto_renew=bool(asset.auto_renew),
        notes=asset.notes,
        renewal_state=state,
        days_to_renewal=days,
        warranty_state=warranty_state(asset),
        current_holder_id=row.user_id if row else None,
        current_holder_name=holder_name,
        current_assignment_id=row.id if row else None,
        assigned_at=row.assigned_at if row else None,
    )


def _assignment_out(
    row: AssetAssignment, *, user_name: str | None, asset: Asset | None
) -> AssetAssignmentOut:
    return AssetAssignmentOut(
        id=row.id,
        asset_id=row.asset_id,
        user_id=row.user_id,
        assigned_at=row.assigned_at,
        returned_at=row.returned_at,
        assigned_condition_note=row.assigned_condition_note,
        returned_condition_note=row.returned_condition_note,
        is_open=row.returned_at is None,
        user_name=user_name,
        asset_tag=asset.asset_tag if asset else None,
        asset_category=asset.category if asset else None,
    )


def _my_asset_out(row: AssetAssignment, asset: Asset) -> MyAssetOut:
    """Built field by field, on purpose.

    ``MyAssetOut`` withholds ``purchase_date`` (what procurement paid is not the
    holder's business) and ``returned_condition_note`` (a note written *about*
    the employee). Constructing it from an explicit field list rather than
    ``model_validate(row)`` or a ``**model_dump()`` splat means adding a column
    to either table can never quietly widen what an employee sees — the new
    field simply is not passed. This is the whole reason the schema is separate
    from ``AssetAssignmentOut``; do not "simplify" it back into a splat.
    """
    return MyAssetOut(
        assignment_id=row.id,
        asset_id=asset.id,
        asset_tag=asset.asset_tag,
        name=asset.name,
        category=asset.category,
        serial_number=asset.serial_number,
        assigned_at=row.assigned_at,
        assigned_condition_note=row.assigned_condition_note,
    )


# --------------------------------------------------------------------------- #
# Register CRUD
# --------------------------------------------------------------------------- #


def list_assets(
    db: Session,
    org_id: uuid.UUID,
    *,
    status_filter: str | None = None,
    category: str | None = None,
    holder_user_id: uuid.UUID | None = None,
) -> list[AssetOut]:
    stmt = select(Asset).where(Asset.org_id == org_id).order_by(Asset.asset_tag)
    if status_filter:
        stmt = stmt.where(Asset.status == status_filter)
    if category:
        stmt = stmt.where(Asset.category == category)
    assets = list(db.scalars(stmt).all())
    held = _open_rows_by_asset(db, org_id, [a.id for a in assets])
    if holder_user_id is not None:
        # Filtered after the holder lookup rather than in SQL because the holder
        # lives in the ledger, and "what is this leaver still holding" is one
        # page of the same register view, not a second query shape to maintain.
        assets = [
            a for a in assets if a.id in held and held[a.id][0].user_id == holder_user_id
        ]
    return [_asset_out(a, held.get(a.id)) for a in assets]


def asset_detail(db: Session, org_id: uuid.UUID, asset_id: uuid.UUID) -> AssetOut:
    """One register row with its current holder resolved, or 404."""
    asset = get_asset(db, org_id, asset_id)
    return _asset_out(asset, _open_rows_by_asset(db, org_id, [asset.id]).get(asset.id))


def create_asset(
    db: Session,
    org_id: uuid.UUID,
    payload: AssetIn,
    *,
    actor: User,
    request: Request | None = None,
) -> AssetOut:
    tag = payload.asset_tag.strip()
    # Checked here for the readable message; the unique index is what actually
    # decides, and the IntegrityError below catches the double-submit race this
    # read-then-write cannot.
    if db.scalar(select(Asset.id).where(Asset.org_id == org_id, Asset.asset_tag == tag)):
        raise HTTPException(
            http_status.HTTP_409_CONFLICT, f"An asset tagged {tag} already exists"
        )

    asset = Asset(
        org_id=org_id,
        asset_tag=tag,
        category=payload.category,
        serial_number=(payload.serial_number or None),
        purchase_date=payload.purchase_date,
        # AssetIn.status cannot express `assigned`, so a newly booked-in asset
        # can never be born claiming a custody it has no ledger row for.
        status=payload.status,
    )
    _apply_details(asset, payload)
    db.add(asset)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            http_status.HTTP_409_CONFLICT, f"An asset tagged {tag} already exists"
        ) from None

    audit(db, org_id=org_id, actor=actor, action="asset.created", request=request,
          target_type="asset", target_id=str(asset.id),
          detail={"asset_tag": asset.asset_tag, "category": asset.category})
    db.commit()
    db.refresh(asset)
    return _asset_out(asset, None)


def _clean(value: str | None) -> str | None:
    value = (value or "").strip()
    return value or None


def _apply_details(asset: Asset, payload: AssetIn) -> None:
    """Copy the descriptive and renewal fields; shared by create and edit."""
    asset.name = _clean(payload.name)
    asset.brand = _clean(payload.brand)
    asset.model_name = _clean(payload.model_name)
    asset.vendor = _clean(payload.vendor)
    asset.invoice_number = _clean(payload.invoice_number)
    asset.purchase_cost_paise = payload.purchase_cost_paise
    asset.location = _clean(payload.location)
    asset.warranty_expiry = payload.warranty_expiry
    asset.renewal_date = payload.renewal_date
    asset.renewal_cycle = payload.renewal_cycle
    asset.renewal_cost_paise = payload.renewal_cost_paise
    asset.reminder_days = payload.reminder_days
    asset.auto_renew = payload.auto_renew
    asset.notes = _clean(payload.notes)


def update_asset(
    db: Session,
    org_id: uuid.UUID,
    asset_id: uuid.UUID,
    payload: AssetIn,
    *,
    actor: User,
    request: Request | None = None,
) -> AssetOut:
    """Edit a register entry. Custody is not editable from here.

    **``status`` is ignored while the asset is out with somebody.** ``AssetIn``
    cannot express ``assigned``, so every edit of an assigned asset — even a
    pure typo fix on a serial number — arrives carrying some *other* status,
    and applying it would silently detach the register from the ledger: exactly
    the drift this module exists to prevent, caused by the most innocuous
    request in the API. Refusing the whole edit instead would mean an assigned
    asset could never be corrected at all. So the ledger wins: while a custody
    row is open the status stays ``assigned``, and an administrator who wants
    the machine marked ``under_repair`` records the return that actually
    happened, which is the event that changed its condition anyway.
    """
    asset = get_asset(db, org_id, asset_id)
    tag = payload.asset_tag.strip()
    clash = db.scalar(
        select(Asset.id).where(
            Asset.org_id == org_id, Asset.asset_tag == tag, Asset.id != asset.id
        )
    )
    if clash:
        raise HTTPException(
            http_status.HTTP_409_CONFLICT, f"An asset tagged {tag} already exists"
        )

    asset.asset_tag = tag
    asset.category = payload.category
    asset.serial_number = payload.serial_number or None
    asset.purchase_date = payload.purchase_date
    _apply_details(asset, payload)
    held = _open_rows_by_asset(db, org_id, [asset.id]).get(asset.id)
    if held is None:
        asset.status = payload.status

    audit(db, org_id=org_id, actor=actor, action="asset.updated", request=request,
          target_type="asset", target_id=str(asset.id),
          detail={"asset_tag": asset.asset_tag, "status": asset.status})
    db.commit()
    db.refresh(asset)
    return _asset_out(asset, _open_rows_by_asset(db, org_id, [asset.id]).get(asset.id))


def delete_asset(
    db: Session,
    org_id: uuid.UUID,
    asset_id: uuid.UUID,
    *,
    actor: User,
    request: Request | None = None,
) -> None:
    """Hard-delete an asset that never had a custody history.

    The relationship cascades ``delete-orphan``, so deleting an asset that *has*
    been issued would take its custody ledger with it and erase the answer to
    "who had this machine in March" — the one question the register exists for.
    Anything ever handed to somebody is retired, not deleted. A mis-typed row
    booked in ten seconds ago has no history and no reason to linger, and that
    is the only case this allows.
    """
    asset = get_asset(db, org_id, asset_id)
    ever_issued = db.scalar(
        select(AssetAssignment.id)
        .where(AssetAssignment.org_id == org_id, AssetAssignment.asset_id == asset.id)
        .limit(1)
    )
    if ever_issued:
        raise HTTPException(
            http_status.HTTP_409_CONFLICT,
            "This asset has been issued before, so deleting it would destroy its "
            "custody history. Set its status to retired instead.",
        )
    tag = asset.asset_tag
    db.delete(asset)
    audit(db, org_id=org_id, actor=actor, action="asset.deleted", request=request,
          target_type="asset", target_id=str(asset_id), detail={"asset_tag": tag})
    db.commit()


# --------------------------------------------------------------------------- #
# Custody lifecycle — the invariant lives in these two functions
# --------------------------------------------------------------------------- #


def assign_asset(
    db: Session,
    org_id: uuid.UUID,
    payload: AssetAssignmentIn,
    *,
    actor: User,
    request: Request | None = None,
) -> AssetAssignmentOut:
    """Open a custody row and move the asset to ``assigned``, atomically.

    Three guards, deliberately not one:

    1. ``status_enum.is_assignable`` refuses an asset in the repair queue or one
       already written off — a fact the ledger has no opinion about.
    2. The ``open_assignment`` read gives a double-assign the readable 409 an
       administrator can act on.
    3. The partial unique index *decides*. Two admins clicking "assign" in the
       same second both pass guard 2, and one of them loses here as an
       ``IntegrityError`` — translated to the same 409 rather than surfacing as
       a 500. Guard 2 exists for the message; this one exists for correctness.

    Every error path above returns before ``db.commit()``, so ``status`` was
    never persisted as ``assigned``. That is the failed-assign half of the
    invariant, and ``test_hrms_assets.py`` asserts it rather than trusting this
    paragraph.
    """
    asset = get_asset(db, org_id, payload.asset_id)

    holder = db.get(User, payload.user_id)
    if holder is None or holder.org_id != org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Employee not found")

    if not asset.status_enum.is_assignable:
        raise HTTPException(
            http_status.HTTP_409_CONFLICT,
            f"{asset.asset_tag} is {asset.status.replace('_', ' ')} and cannot be issued",
        )
    if open_assignment(db, org_id, asset.id) is not None:
        raise HTTPException(
            http_status.HTTP_409_CONFLICT,
            f"{asset.asset_tag} is already issued and must be returned first",
        )

    now = datetime.now(timezone.utc)
    assigned_at = _aware(payload.assigned_at) if payload.assigned_at else now
    if assigned_at > now:
        # A future-dated handover makes the register claim somebody holds a
        # machine that is still in the cupboard, and no job will ever come back
        # later and make that true.
        raise HTTPException(
            http_status.HTTP_400_BAD_REQUEST, "A handover cannot be dated in the future"
        )
    _reject_backdated_overlap(db, org_id, asset, assigned_at)

    row = AssetAssignment(
        org_id=org_id,
        asset_id=asset.id,
        user_id=holder.id,
        assigned_at=assigned_at,
        assigned_condition_note=payload.assigned_condition_note or None,
    )
    db.add(row)
    # Both halves in one unit of work. Do not move this below the flush: if the
    # partial index rejects the ledger row, the rollback must take the status
    # change with it.
    asset.status = AssetStatus.ASSIGNED.value
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            http_status.HTTP_409_CONFLICT,
            f"{asset.asset_tag} is already issued and must be returned first",
        ) from None

    audit(db, org_id=org_id, actor=actor, action="asset.assigned", request=request,
          target_type="asset", target_id=str(asset.id),
          detail={"assignment_id": str(row.id), "user_id": str(holder.id),
                  "asset_tag": asset.asset_tag})
    db.commit()
    db.refresh(row)
    return _assignment_out(row, user_name=holder.full_name, asset=asset)


def return_asset(
    db: Session,
    org_id: uuid.UUID,
    asset_id: uuid.UUID,
    payload: AssetReturnIn,
    *,
    actor: User,
    request: Request | None = None,
) -> AssetAssignmentOut:
    """Close the open custody row and move the asset to ``resulting_status``.

    ``resulting_status`` is honoured, not assumed: "returned" and "available
    again" are different events, and a laptop handed back with a cracked screen
    lands in ``under_repair``, where guard 1 of ``assign_asset`` refuses it
    instead of issuing a broken machine to the next joiner. Hard-coding
    ``available`` here would make the repair queue depend on an administrator
    remembering a second edit that nothing prompts them to make.
    """
    asset = get_asset(db, org_id, asset_id)
    row = open_assignment(db, org_id, asset.id)
    if row is None:
        # Reconciles the register on the way out, deliberately. Reaching here
        # with status == 'assigned' means the drift this module guards against
        # already happened once; refusing without repairing it would leave the
        # asset permanently unissuable, because assign's guard 1 would keep
        # rejecting it forever and nothing else clears the status.
        if asset.status_enum is AssetStatus.ASSIGNED:
            asset.status = AssetStatus.AVAILABLE.value
            audit(db, org_id=org_id, actor=actor, action="asset.status_reconciled",
                  request=request, target_type="asset", target_id=str(asset.id),
                  detail={"asset_tag": asset.asset_tag, "from": "assigned"})
            db.commit()
        raise HTTPException(
            http_status.HTTP_409_CONFLICT,
            f"{asset.asset_tag} is not currently issued to anybody",
        )

    now = datetime.now(timezone.utc)
    returned_at = _aware(payload.returned_at) if payload.returned_at else now
    if returned_at > now:
        raise HTTPException(
            http_status.HTTP_400_BAD_REQUEST, "A return cannot be dated in the future"
        )
    if returned_at < _aware(row.assigned_at):
        # A custody period that ends before it starts is not a validation
        # nicety: it inverts every "who held this on date X" query anyone
        # writes against this table from here on.
        raise HTTPException(
            http_status.HTTP_400_BAD_REQUEST,
            "The return date is before the asset was handed over",
        )

    row.returned_at = returned_at
    row.returned_condition_note = payload.returned_condition_note or None
    # Same transaction as the ledger close. See the module docstring.
    asset.status = payload.resulting_status

    audit(db, org_id=org_id, actor=actor, action="asset.returned", request=request,
          target_type="asset", target_id=str(asset.id),
          detail={"assignment_id": str(row.id), "user_id": str(row.user_id),
                  "asset_tag": asset.asset_tag, "resulting_status": asset.status})
    db.commit()
    db.refresh(row)
    holder = db.get(User, row.user_id)
    return _assignment_out(row, user_name=holder.full_name if holder else None, asset=asset)


def _reject_backdated_overlap(
    db: Session, org_id: uuid.UUID, asset: Asset, assigned_at: datetime
) -> None:
    """Refuse a handover backdated into a period the asset was already out.

    The partial unique index constrains open rows only, so the database accepts
    overlapping *closed* periods without complaint — confirmed in Phase 0. The
    new row is open-ended, so it overlaps any closed period ending strictly
    after it starts. Touching endpoints (returned 17:00, re-issued 17:00) are
    legal: that is a same-day handover between two people, not an overlap.
    """
    closed = db.scalars(
        select(AssetAssignment).where(
            AssetAssignment.org_id == org_id,
            AssetAssignment.asset_id == asset.id,
            AssetAssignment.returned_at.is_not(None),
        )
    ).all()
    for row in closed:
        if _aware(row.returned_at) > assigned_at:
            raise HTTPException(
                http_status.HTTP_409_CONFLICT,
                f"{asset.asset_tag} was still issued to somebody else at that date",
            )


# --------------------------------------------------------------------------- #
# History and the employee's own view
# --------------------------------------------------------------------------- #


def custody_history(
    db: Session, org_id: uuid.UUID, asset_id: uuid.UUID
) -> list[AssetAssignmentOut]:
    """Every custody period for one asset, newest first.

    Includes the open row, so this is "who has it and who had it" in a single
    call rather than a header plus a table the console has to stitch together.
    """
    asset = get_asset(db, org_id, asset_id)
    rows = db.execute(
        select(AssetAssignment, User.full_name)
        .join(User, User.id == AssetAssignment.user_id)
        .where(AssetAssignment.org_id == org_id, AssetAssignment.asset_id == asset.id)
        .order_by(AssetAssignment.assigned_at.desc())
    ).all()
    return [_assignment_out(row, user_name=name, asset=asset) for row, name in rows]


def user_history(
    db: Session, org_id: uuid.UUID, user_id: uuid.UUID
) -> list[AssetAssignmentOut]:
    """Everything one person has ever held — the offboarding question.

    A plain function on purpose: offboarding can call it without this module
    ever importing, or knowing about, offboarding.
    """
    rows = db.execute(
        select(AssetAssignment, Asset, User.full_name)
        .join(Asset, Asset.id == AssetAssignment.asset_id)
        .join(User, User.id == AssetAssignment.user_id)
        .where(AssetAssignment.org_id == org_id, AssetAssignment.user_id == user_id)
        .order_by(AssetAssignment.assigned_at.desc())
    ).all()
    return [_assignment_out(row, user_name=name, asset=asset) for row, asset, name in rows]


def my_assets(db: Session, org_id: uuid.UUID, user_id: uuid.UUID) -> list[MyAssetOut]:
    """What this person is holding right now, in the withheld-field shape.

    Open rows only. An employee's own list is a reminder of what they must hand
    back, not a record of everything they have ever been given — and the
    return-side note on a closed row is written about them, not for them.
    """
    rows = db.execute(
        select(AssetAssignment, Asset)
        .join(Asset, Asset.id == AssetAssignment.asset_id)
        .where(
            AssetAssignment.org_id == org_id,
            AssetAssignment.user_id == user_id,
            AssetAssignment.returned_at.is_(None),
        )
        .order_by(AssetAssignment.assigned_at.desc())
    ).all()
    return [_my_asset_out(row, asset) for row, asset in rows]


# --------------------------------------------------------------------------- #
# Renewals
# --------------------------------------------------------------------------- #


def _renewal_out(
    row: AssetRenewal, *, asset: Asset | None, by_name: str | None
) -> AssetRenewalOut:
    return AssetRenewalOut(
        id=row.id,
        asset_id=row.asset_id,
        renewed_on=row.renewed_on,
        previous_due=row.previous_due,
        next_due=row.next_due,
        cost_paise=row.cost_paise,
        reference=row.reference,
        note=row.note,
        renewed_by_name=by_name,
        asset_tag=asset.asset_tag if asset else None,
        asset_name=asset.name if asset else None,
        created_at=row.created_at,
    )


def renew_asset(
    db: Session,
    org_id: uuid.UUID,
    asset_id: uuid.UUID,
    payload: AssetRenewIn,
    *,
    actor: User,
    request: Request | None = None,
) -> AssetOut:
    """Record a renewal and move the asset's due date forward.

    The next due date is, in order: the one given; else one cycle on from the
    previous due date (from the renewal day when there was none); else, for a
    cycle of ``none``, the caller must say — guessing a date for a one-off
    expiry would be inventing a contract term.
    """
    asset = get_asset(db, org_id, asset_id)
    if asset.status_enum is AssetStatus.RETIRED:
        raise HTTPException(
            http_status.HTTP_409_CONFLICT, f"{asset.asset_tag} is retired and cannot be renewed"
        )
    renewed_on = payload.renewed_on or _today()
    previous = asset.renewal_date

    if payload.stop_tracking:
        next_due = None
    elif payload.next_due is not None:
        next_due = payload.next_due
    else:
        try:
            months = RenewalCycle(asset.renewal_cycle).months
        except ValueError:
            months = 0
        if months == 0:
            raise HTTPException(
                http_status.HTTP_400_BAD_REQUEST,
                "This asset has no renewal cycle, so give the next due date",
            )
        next_due = add_months(previous or renewed_on, months)
    if next_due is not None and next_due <= renewed_on:
        raise HTTPException(
            http_status.HTTP_400_BAD_REQUEST, "The next due date must be after the renewal date"
        )

    cost = payload.cost_paise if payload.cost_paise is not None else asset.renewal_cost_paise
    row = AssetRenewal(
        org_id=org_id,
        asset_id=asset.id,
        renewed_on=renewed_on,
        previous_due=previous,
        next_due=next_due,
        cost_paise=cost,
        reference=_clean(payload.reference),
        note=_clean(payload.note),
        renewed_by_id=actor.id,
    )
    db.add(row)
    asset.renewal_date = next_due
    if payload.cost_paise is not None:
        asset.renewal_cost_paise = payload.cost_paise

    audit(db, org_id=org_id, actor=actor, action="asset.renewed", request=request,
          target_type="asset", target_id=str(asset.id),
          detail={"asset_tag": asset.asset_tag,
                  "previous_due": previous.isoformat() if previous else None,
                  "next_due": next_due.isoformat() if next_due else None})
    db.commit()
    db.refresh(asset)
    return _asset_out(asset, _open_rows_by_asset(db, org_id, [asset.id]).get(asset.id))


def renewal_history(
    db: Session, org_id: uuid.UUID, asset_id: uuid.UUID | None = None, *, limit: int | None = None
) -> list[AssetRenewalOut]:
    """Renewals newest first — for one asset, or across the register."""
    stmt = (
        select(AssetRenewal, Asset, User.full_name)
        .join(Asset, Asset.id == AssetRenewal.asset_id)
        .outerjoin(User, User.id == AssetRenewal.renewed_by_id)
        .where(AssetRenewal.org_id == org_id)
        .order_by(AssetRenewal.renewed_on.desc(), AssetRenewal.created_at.desc())
    )
    if asset_id is not None:
        get_asset(db, org_id, asset_id)
        stmt = stmt.where(AssetRenewal.asset_id == asset_id)
    if limit:
        stmt = stmt.limit(limit)
    return [_renewal_out(r, asset=a, by_name=n) for r, a, n in db.execute(stmt).all()]


# --------------------------------------------------------------------------- #
# Dashboard
# --------------------------------------------------------------------------- #


def dashboard(db: Session, org_id: uuid.UUID) -> AssetDashboardOut:
    """Counts, renewals and holders for the asset dashboard, in one pass.

    Computed in Python over the register rather than with a dozen aggregate
    queries: a register is hundreds of rows, and the renewal state has to be
    derived per row against each asset's own reminder window anyway.
    """
    rows = list_assets(db, org_id)
    today = _today()
    horizon = today + timedelta(days=UPCOMING_WINDOW_DAYS)

    by_status: dict[str, int] = {}
    by_category: dict[str, CountRow] = {}
    holders: dict[uuid.UUID, HolderRow] = {}
    total_value = 0
    overdue = due = upcoming = tracked = 0
    cost_due = cost_90 = 0
    w_expiring = w_expired = 0

    for a in rows:
        by_status[a.status] = by_status.get(a.status, 0) + 1
        cat = by_category.setdefault(a.category, CountRow(key=a.category, count=0))
        cat.count += 1
        if a.status != AssetStatus.RETIRED.value:
            total_value += a.purchase_cost_paise or 0
            cat.value_paise += a.purchase_cost_paise or 0
        if a.current_holder_id is not None:
            h = holders.setdefault(
                a.current_holder_id,
                HolderRow(user_id=a.current_holder_id, name=a.current_holder_name or "Unknown",
                          count=0),
            )
            h.count += 1
            h.value_paise += a.purchase_cost_paise or 0
        if a.renewal_state != "none":
            tracked += 1
        if a.renewal_state == "overdue":
            overdue += 1
            cost_due += a.renewal_cost_paise or 0
        elif a.renewal_state == "due":
            due += 1
            cost_due += a.renewal_cost_paise or 0
        elif a.renewal_state == "upcoming":
            upcoming += 1
        if a.renewal_state != "none" and a.renewal_date and a.renewal_date <= horizon:
            cost_90 += a.renewal_cost_paise or 0
        if a.warranty_state == "expiring":
            w_expiring += 1
        elif a.warranty_state == "expired":
            w_expired += 1

    if holders:
        emails = dict(db.execute(
            select(User.id, User.email).where(User.id.in_(list(holders)))
        ).all())
        for uid, h in holders.items():
            h.email = emails.get(uid)

    attention = sorted(
        (a for a in rows if a.renewal_state in ("overdue", "due", "upcoming")),
        key=lambda a: a.renewal_date or today,
    )[:12]

    return AssetDashboardOut(
        total=len(rows),
        active=len(rows) - by_status.get(AssetStatus.RETIRED.value, 0),
        total_value_paise=total_value,
        by_status=by_status,
        by_category=sorted(by_category.values(), key=lambda c: -c.count),
        assigned=by_status.get(AssetStatus.ASSIGNED.value, 0),
        holders=len(holders),
        renewals_tracked=tracked,
        renewals_overdue=overdue,
        renewals_due=due,
        renewals_upcoming=upcoming,
        renewal_cost_due_paise=cost_due,
        renewal_cost_90d_paise=cost_90,
        warranty_expiring=w_expiring,
        warranty_expired=w_expired,
        attention=attention,
        top_holders=sorted(holders.values(), key=lambda h: (-h.count, h.name))[:10],
        recent_renewals=renewal_history(db, org_id, limit=8),
    )
