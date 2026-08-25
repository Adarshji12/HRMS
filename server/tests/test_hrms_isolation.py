"""One company must never reach another's HRMS data.

The sibling of ``test_tenant_isolation.py``, for the seven modules Phases 1-9
added. The property is identical and so is the stake: this product now holds
each company's attendance, leave, exits, assets and grievances, and the single
failure that ends it is company A reading — or worse, deciding — company B's.

Five things this file does that a list of endpoint smoke tests would not:

* **The schema check walks ``Base.metadata``**, it does not enumerate table
  names. A table added in Phase 12 and never mentioned here still has to carry
  a cascading, indexed, non-null ``org_id`` or this suite goes red. A checklist
  of names would silently stop covering the codebase the day someone forgot to
  add one, which is exactly the day it matters.
* **A refusal is asserted against the data, not only the status.** A 404 that
  returned after the write already committed passes a status-only check and
  loses a company its attendance record. Every cross-tenant write below reads
  the row back through the *owning* tenant afterwards.
* **404, never 403, on a foreign id.** A 403 says "this exists, you may not
  have it", which turns every id endpoint into an oracle for enumerating
  another company's rows. ``test_tenant_isolation.py`` asserts this as
  "foreign and unknown are indistinguishable"; the same pairing is used here,
  per endpoint, rather than a loose ``in (403, 404)``.
* **Uniqueness is asserted to be per-org.** A global unique index on an asset
  tag, a leave type name or a shift name is invisible on a one-tenant dev box
  and breaks the *second* company to onboard, in production, on their first
  day. Both halves are covered: the structural rule, and two tenants actually
  creating the same names.
* **A foreign id in the request *body* is treated as its own attack.** Part 4b
  sends requests that are legitimate in every respect — own token, own host,
  own row in the URL — with one field naming somebody else's row. A handler
  that scopes what it is editing and then trusts the body leaves a live
  pointer from one tenant's table into another's, which no URL-scoped check
  would ever see. Each of those refusals is followed by a sweep of every
  ``Uuid`` column in the schema, and the sweep itself has a positive control.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import UniqueConstraint, Uuid, select

from app.db.base import Base
from app.db.session import SessionLocal
from app.models import (
    Asset,
    AttendanceRecord,
    HelpdeskComment,
    HelpdeskTicket,
    Holiday,
    LeaveApplication,
    OfficeLocation,
    OffboardingFnf,
    OffboardingRequest,
    OnboardingDocument,
    OnboardingTask,
    OnboardingTemplate,
    RegularizationRequest,
    Shift,
    ShiftAssignment,
    User,
)


# --------------------------------------------------------------------------- #
# Part 1 — the schema itself
# --------------------------------------------------------------------------- #

#: Tables that are deliberately not tenant-scoped. Each one is above the tenant
#: boundary rather than inside it, so an ``org_id`` on it would be meaningless:
#: an organisation cannot belong to itself, a subscription plan is catalogue
#: data shared by every tenant, and a platform operator exists outside all of
#: them by definition. Kept as a short, named list precisely so that adding a
#: table to it is a visible decision in a diff.
NOT_TENANT_SCOPED = {"organizations", "plans", "platform_admins"}

#: Pre-existing tables that predate the HRMS work and bend one of the rules
#: below for a stated reason. Nothing new may join this set: every HRMS table
#: passes every rule unaided, and the assertion in
#: ``test_the_org_id_exemptions_are_still_real`` makes a stale entry fail
#: rather than quietly widen the exemption.
NULLABLE_ORG_ID_BY_DESIGN = {
    # A platform-level audit row (a super-admin acting outside any tenant) has
    # no organisation to name, and losing that row would be worse than the
    # inconsistency.
    "audit_logs",
    # Outbound mail can be configured platform-wide as the fallback every
    # tenant without its own connector uses.
    "mail_settings",
}
UNINDEXED_ORG_ID_BY_DESIGN = {
    # High-volume append-only capture. It is only ever read through
    # ``(user_id, captured_at)``, which is the index it has; a second index on
    # the write-heaviest table in the product would cost more than it returns.
    "screenshots",
}
#: Unique indexes that are global on purpose. All three are credentials or
#: external references whose whole job is to be unique across the platform —
#: two tenants sharing a device token is the bug, not the constraint.
GLOBALLY_UNIQUE_BY_DESIGN = {
    "ix_devices_token_hash",
    "ix_users_enrollment_key",
    "ix_payments_order_id",
}


def _table_id(value) -> str:
    """Name the parametrised case after the table, not ``table0``."""
    return value if isinstance(value, str) else ""


def _tenant_tables():
    return sorted(
        (name, table)
        for name, table in Base.metadata.tables.items()
        if name not in NOT_TENANT_SCOPED
    )


def test_the_org_id_exemptions_are_still_real():
    """Every name exempted above must still be a table, and still need it.

    Without this, a table that is renamed or gains its missing index leaves a
    dead entry behind, and the next table to inherit that name inherits the
    exemption with it.
    """
    known = set(Base.metadata.tables)
    for name in NOT_TENANT_SCOPED | NULLABLE_ORG_ID_BY_DESIGN | UNINDEXED_ORG_ID_BY_DESIGN:
        assert name in known, f"{name} is exempted but no longer exists"

    for name in NULLABLE_ORG_ID_BY_DESIGN:
        assert Base.metadata.tables[name].c["org_id"].nullable, (
            f"{name}.org_id is now NOT NULL — drop it from NULLABLE_ORG_ID_BY_DESIGN"
        )

    index_names = {
        index.name for table in Base.metadata.tables.values() for index in table.indexes
    }
    for name in GLOBALLY_UNIQUE_BY_DESIGN:
        assert name in index_names, f"{name} is exempted but no longer exists"


@pytest.mark.parametrize("name,table", _tenant_tables(), ids=_table_id)
def test_every_table_carries_org_id(name, table):
    """§12's first checklist item, asserted structurally.

    Derived from the mapper registry rather than a list of names, so a table
    added by a later phase and never thought about fails here on the day it
    lands instead of on the day two tenants meet in production.
    """
    assert "org_id" in table.c, (
        f"{name} has no org_id. Either it is tenant data and needs one, or it "
        f"belongs in NOT_TENANT_SCOPED with a reason."
    )


@pytest.mark.parametrize("name,table", _tenant_tables(), ids=_table_id)
def test_every_org_id_cascades_from_organizations(name, table):
    """A tenant deletion must not leave its rows behind.

    Orphaned rows with a dangling ``org_id`` are worse than a foreign-key
    error: they survive the deletion of the company that owned them, and the
    next org to be issued that UUID would inherit them.
    """
    column = table.c["org_id"]
    targets = [(fk.column.table.name, fk.column.name, fk.ondelete) for fk in column.foreign_keys]
    assert targets, f"{name}.org_id is not a foreign key at all"
    target_table, target_column, ondelete = targets[0]
    assert (target_table, target_column) == ("organizations", "id"), (
        f"{name}.org_id points at {target_table}.{target_column}"
    )
    assert (ondelete or "").upper() == "CASCADE", (
        f"{name}.org_id has ondelete={ondelete!r}, not CASCADE"
    )


@pytest.mark.parametrize("name,table", _tenant_tables(), ids=_table_id)
def test_every_org_id_is_non_null(name, table):
    """A NULL ``org_id`` is a row belonging to no tenant — and therefore, to
    whichever query forgets to filter, to all of them."""
    if name in NULLABLE_ORG_ID_BY_DESIGN:
        pytest.skip("nullable by design; see NULLABLE_ORG_ID_BY_DESIGN")
    assert not table.c["org_id"].nullable, f"{name}.org_id is nullable"


@pytest.mark.parametrize("name,table", _tenant_tables(), ids=_table_id)
def test_every_org_id_is_indexed(name, table):
    """Not a performance nicety.

    Every tenant-scoped query in the codebase filters on ``org_id`` first. An
    unindexed one turns into a full table scan the moment a second company
    signs up, which is the point at which nobody is watching the dev box.
    """
    if name in UNINDEXED_ORG_ID_BY_DESIGN:
        pytest.skip("covered by a composite index; see UNINDEXED_ORG_ID_BY_DESIGN")
    column = table.c["org_id"]
    leads_an_index = any(
        list(index.columns) and list(index.columns)[0].name == "org_id"
        for index in table.indexes
    )
    assert column.index or column.primary_key or leads_an_index, (
        f"{name}.org_id has no index and does not lead a composite one"
    )


def _is_tenant_rooted(columns) -> bool:
    """True when this column set can only ever collide inside one tenant.

    Two ways to qualify. Either ``org_id`` is in the constraint outright, or
    one of its columns is a foreign key to another table's primary key — a
    UUID that is already unique across the platform and already belongs to
    exactly one tenant, so a constraint hanging off it cannot reach across the
    boundary. ``uq_asset_assignments_open_per_asset`` is the second kind:
    scoped by ``asset_id``, and an asset belongs to one company.
    """
    names = {column.name for column in columns}
    if "org_id" in names:
        return True
    return any(
        fk.column.primary_key and fk.column.table.name != "organizations"
        for column in columns
        for fk in column.foreign_keys
    )


@pytest.mark.parametrize("name,table", _tenant_tables(), ids=_table_id)
def test_uniqueness_is_scoped_to_one_tenant(name, table):
    """A global unique key breaks the *second* company to use a common name.

    Nobody hits it in development, where there is one tenant, and nobody hits
    it in staging, where there are two with different data. It surfaces when a
    real customer onboards and cannot name a shift "General" because somebody
    else already did — which reads to them as the product being broken, and to
    us as a schema change under a live table.
    """
    unique_sets = [
        (constraint.name, list(constraint.columns))
        for constraint in table.constraints
        if isinstance(constraint, UniqueConstraint)
    ] + [
        (index.name, list(index.columns)) for index in table.indexes if index.unique
    ]

    for constraint_name, columns in unique_sets:
        if constraint_name in GLOBALLY_UNIQUE_BY_DESIGN:
            continue
        assert _is_tenant_rooted(columns), (
            f"{name}.{constraint_name} on {[c.name for c in columns]} is unique "
            f"across every tenant. Add org_id to it."
        )


# --------------------------------------------------------------------------- #
# Fixtures — a full HRMS tenant, built through the API
# --------------------------------------------------------------------------- #

ATT = "/api/v1/attendance"
REG = "/api/v1/regularization"
LEAVE = "/api/v1/leave"
ONB = "/api/v1/onboarding"
OFFB = "/api/v1/offboarding"
ASSETS = "/api/v1/assets"
HELP = "/api/v1/helpdesk"


def _next_weekday(offset_days: int = 14) -> date:
    """A future date that is definitely a working day.

    Leave applied for on a weekly-off costs zero days, and a zero-day
    application is refused — so a test that happened to run on a Friday would
    fail for a reason that has nothing to do with tenancy.
    """
    day = date.today() + timedelta(days=offset_days)
    while day.weekday() >= 5:
        day += timedelta(days=1)
    return day


def _first_task_id(groups) -> str:
    """The first task id out of a grouped checklist.

    Onboarding and offboarding both return tasks nested under their category
    groups rather than as a flat list, and both put empty groups first, so
    indexing group zero would be a flaky test that depends on the default
    checklist's shape.
    """
    for group in groups:
        for task in group["tasks"]:
            return task["id"]
    raise AssertionError("the checklist was created with no tasks on it")


def _seed(client, tenant) -> dict:
    """One row in every HRMS module, created through the real API.

    Through the API rather than by inserting rows, because a row inserted
    directly can be *shaped* wrong in a way the service would never produce,
    and then the isolation test proves something about data that cannot exist.
    """
    owner = tenant.headers()
    staff = tenant.headers(tenant.employee_token)
    made: dict = {}

    # --- attendance ---------------------------------------------------------
    location = client.post(
        f"{ATT}/locations",
        json={"name": "Head Office", "lat": 12.97, "lng": 77.59, "radius_m": 200},
        headers=owner,
    )
    assert location.status_code == 201, location.text
    made["location_id"] = location.json()["id"]

    # Named "General" in both tenants on purpose — see the uniqueness tests.
    shift = client.post(f"{ATT}/shifts", json={"name": "General"}, headers=owner)
    assert shift.status_code == 201, shift.text
    made["shift_id"] = shift.json()["id"]

    assignment = client.post(
        f"{ATT}/shift-assignments",
        json={
            "user_id": str(tenant.employee.id),
            "shift_id": made["shift_id"],
            "effective_from": date.today().isoformat(),
        },
        headers=owner,
    )
    assert assignment.status_code == 201, assignment.text
    made["shift_assignment_id"] = assignment.json()["id"]

    punch = client.post(f"{ATT}/punch/in", json={"source": "web"}, headers=staff)
    assert punch.status_code == 201, punch.text
    # The punch response is a day-shaped view with no row id on it (§2.3 —
    # the calendar cell is the contract, not the table), so the id
    # ``/attendance/records/{id}`` needs comes from the row itself.
    with SessionLocal() as db:
        made["record_id"] = str(
            db.scalar(
                select(AttendanceRecord.id).where(
                    AttendanceRecord.org_id == tenant.id,
                    AttendanceRecord.user_id == tenant.employee.id,
                )
            )
        )

    # --- regularization -----------------------------------------------------
    corrected = datetime.now(timezone.utc) - timedelta(days=3)
    regularization = client.post(
        REG,
        json={
            "date": (date.today() - timedelta(days=3)).isoformat(),
            "requested_check_in": corrected.replace(hour=9, minute=0).isoformat(),
            "requested_check_out": corrected.replace(hour=18, minute=0).isoformat(),
            "reason": "Badge reader was down at the gate.",
        },
        headers=staff,
    )
    assert regularization.status_code == 201, regularization.text
    made["regularization_id"] = regularization.json()["id"]

    # --- leave --------------------------------------------------------------
    leave_type = client.post(
        f"{LEAVE}/types",
        json={"name": "Casual", "code": "CL", "accrual_type": "none"},
        headers=owner,
    )
    assert leave_type.status_code == 201, leave_type.text
    made["leave_type_id"] = leave_type.json()["id"]

    holiday = client.post(
        f"{LEAVE}/holidays",
        json={"holiday_date": _next_weekday(60).isoformat(), "name": "Founders Day"},
        headers=owner,
    )
    assert holiday.status_code == 201, holiday.text
    made["holiday_id"] = holiday.json()["id"]

    granted = client.post(
        f"{LEAVE}/balances/adjust",
        json={
            "user_id": str(tenant.employee.id),
            "leave_type_id": made["leave_type_id"],
            "year": date.today().year,
            "delta_milli_days": 10_000,
            "reason": "Opening balance at go-live",
        },
        headers=owner,
    )
    assert granted.status_code == 200, granted.text

    when = _next_weekday()
    application = client.post(
        f"{LEAVE}/applications",
        json={
            "leave_type_id": made["leave_type_id"],
            "start_date": when.isoformat(),
            "end_date": when.isoformat(),
            "reason": "Family function",
        },
        headers=staff,
    )
    assert application.status_code == 201, application.text
    made["leave_application_id"] = application.json()["id"]

    # --- onboarding ---------------------------------------------------------
    template = client.post(
        f"{ONB}/templates",
        json={
            "name": "Standard Joiner",
            "tasks": [{"title": "Sign the handbook", "category": "documentation"}],
        },
        headers=owner,
    )
    assert template.status_code == 201, template.text
    made["template_id"] = template.json()["id"]

    instance = client.post(
        f"{ONB}/instances",
        json={
            "user_id": str(tenant.employee.id),
            "template_id": made["template_id"],
            "joining_date": date.today().isoformat(),
        },
        headers=owner,
    )
    assert instance.status_code == 201, instance.text
    made["instance_id"] = instance.json()["id"]
    made["onboarding_task_id"] = _first_task_id(instance.json()["groups"])

    # --- offboarding --------------------------------------------------------
    exit_request = client.post(
        f"{OFFB}/requests",
        json={
            "user_id": str(tenant.employee.id),
            "reason": "resignation",
            "notice_date": date.today().isoformat(),
            "last_working_day": (date.today() + timedelta(days=30)).isoformat(),
        },
        headers=owner,
    )
    assert exit_request.status_code == 201, exit_request.text
    made["offboarding_id"] = exit_request.json()["id"]
    made["offboarding_task_id"] = _first_task_id(exit_request.json()["clearance"])

    # --- assets -------------------------------------------------------------
    # Tagged LAP-001 in both tenants on purpose.
    asset = client.post(
        ASSETS, json={"asset_tag": "LAP-001", "category": "laptop"}, headers=owner
    )
    assert asset.status_code == 201, asset.text
    made["asset_id"] = asset.json()["id"]

    handed_over = client.post(
        f"{ASSETS}/assign",
        json={"asset_id": made["asset_id"], "user_id": str(tenant.employee.id)},
        headers=owner,
    )
    assert handed_over.status_code == 201, handed_over.text
    made["assignment_id"] = handed_over.json()["id"]

    # --- helpdesk -----------------------------------------------------------
    category = client.post(
        f"{HELP}/categories", json={"name": "Payroll"}, headers=owner
    )
    assert category.status_code == 201, category.text
    made["category_id"] = category.json()["id"]

    ticket = client.post(
        f"{HELP}/tickets",
        json={"subject": "Payslip is wrong", "description": "March net pay looks short."},
        headers=staff,
    )
    assert ticket.status_code == 201, ticket.text
    made["ticket_id"] = ticket.json()["id"]

    return made


@pytest.fixture
def seeded(client, tenants):
    """Both companies, each holding a full set of HRMS rows.

    Both, not one. Seeding only the victim would let an endpoint that returns
    an empty list to *everybody* — a broken filter, a missing join — pass every
    read test in this file while being useless. With both tenants populated,
    a cross-tenant read that returns rows returns the *wrong* rows, and the
    assertions below can say so.
    """
    acme, globex = tenants
    return acme, globex, _seed(client, acme), _seed(client, globex)


# --------------------------------------------------------------------------- #
# Part 2 — cross-tenant reads return the caller's own data and nothing else
# --------------------------------------------------------------------------- #

#: Every list endpoint across the seven modules. Anything returning a JSON
#: array of tenant rows belongs here; the settings singletons are checked
#: separately below because "is not the other tenant's" is a different
#: assertion for an object than for a list.
LIST_ENDPOINTS = [
    f"{ATT}/me",
    f"{ATT}/team",
    f"{ATT}/locations",
    f"{ATT}/shifts",
    f"{ATT}/shift-assignments",
    REG,
    f"{REG}/review",
    f"{LEAVE}/types",
    f"{LEAVE}/holidays",
    f"{LEAVE}/holidays/opt-ins",
    f"{LEAVE}/balances",
    f"{LEAVE}/applications",
    f"{LEAVE}/applications/review",
    f"{LEAVE}/comp-offs",
    f"{ONB}/templates",
    f"{ONB}/instances",
    f"{OFFB}/requests",
    f"{ASSETS}/my",
    ASSETS,
    f"{HELP}/categories",
    f"{HELP}/tickets",
    f"{HELP}/staff/tickets",
]


#: Seeded ids that no list endpoint returns, by design rather than by omission.
#: Excluded from the aggregate visibility test below — they are still checked
#: for *leakage*, which is the direction that matters.
ABSENT_FROM_EVERY_LIST = {
    # ``AttendanceDayOut`` is a calendar cell, not a table row: it carries the
    # day, not the record id (§2.3).
    "record_id",
    # Checklist items are nested inside a detail response, never on the
    # pipeline list row.
    "onboarding_task_id",
    "offboarding_task_id",
}


def _ids_in(payload) -> set[str]:
    """Every UUID-shaped string anywhere in a response body.

    Deliberately indiscriminate. Checking only the top-level ``id`` would miss
    the interesting leaks — a foreign ``user_id`` on a derived field, a foreign
    ``asset_tag``'s owning row nested two levels down — and those are the ones
    that are hard to spot by eye in review.
    """
    found: set[str] = set()

    def walk(node):
        if isinstance(node, dict):
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)
        elif isinstance(node, str):
            try:
                uuid.UUID(node)
            except ValueError:
                return
            found.add(node.lower())

    walk(payload)
    return found


@pytest.mark.parametrize("path", LIST_ENDPOINTS)
def test_a_list_endpoint_never_returns_another_tenants_rows(client, seeded, path):
    acme, globex, acme_rows, _ = seeded
    response = client.get(path, headers=globex.headers())
    assert response.status_code == 200, f"{path} refused its own tenant: {response.text[:200]}"

    leaked = _ids_in(response.json()) & {
        str(value).lower() for value in acme_rows.values()
    }
    assert not leaked, f"{path} returned Acme rows to Globex: {sorted(leaked)}"
    assert str(acme.employee.id).lower() not in _ids_in(response.json()), (
        f"{path} disclosed an Acme employee id to Globex"
    )


@pytest.mark.parametrize("path", LIST_ENDPOINTS)
def test_the_same_list_endpoints_answer_their_own_tenant(client, tenants, path):
    """The other half of the guard above, endpoint by endpoint.

    An endpoint that refused everybody would satisfy "returns no foreign rows"
    perfectly while being completely broken, so each one is asked by a tenant
    that is entitled to it. Deliberately on an *unseeded* tenant: the question
    here is whether the endpoint answers at all, and the harder question —
    whether it returns the rows that tenant created — is aggregate and lives
    in the test below.
    """
    acme, _ = tenants
    response = client.get(path, headers=acme.headers())
    assert response.status_code == 200, f"{path} refused its own tenant: {response.text[:200]}"


def test_the_seeded_tenant_can_actually_see_what_it_created(client, seeded):
    """Aggregate proof that the read tests above are exercising real data.

    Without this, ``LIST_ENDPOINTS`` could drift into a set of paths that
    return nothing to anyone and the whole part-2 block would still be green.
    """
    acme, _, acme_rows, _ = seeded
    seen: set[str] = set()
    for path in LIST_ENDPOINTS:
        response = client.get(path, headers=acme.headers())
        assert response.status_code == 200, f"{path}: {response.text[:200]}"
        seen |= _ids_in(response.json())

    expected = {
        str(value).lower()
        for key, value in acme_rows.items()
        if key not in ABSENT_FROM_EVERY_LIST
    }
    missing = expected - seen
    assert not missing, (
        "Acme cannot see rows it created through its own list endpoints: "
        f"{sorted(missing)}"
    )


def test_attendance_settings_are_not_shared_between_tenants(client, seeded):
    """The settings singletons: one object per org, not one per platform."""
    acme, globex, _, _ = seeded
    changed = client.put(
        f"{ATT}/settings", json={"geofence_enforcement": "off"}, headers=acme.headers()
    )
    assert changed.status_code == 200, changed.text

    theirs = client.get(f"{ATT}/settings", headers=globex.headers())
    assert theirs.status_code == 200
    assert theirs.json()["geofence_enforcement"] != "off", (
        "Globex inherited Acme's geofence policy"
    )
    assert theirs.json()["active_location_count"] == 1, (
        "Globex's office count includes Acme's offices"
    )


def test_leave_settings_are_not_shared_between_tenants(client, seeded):
    acme, globex, _, _ = seeded
    current = client.get(f"{LEAVE}/settings", headers=acme.headers()).json()
    changed = client.put(
        f"{LEAVE}/settings", json={**current, "leave_year_start_month": 4}, headers=acme.headers()
    )
    assert changed.status_code == 200, changed.text

    theirs = client.get(f"{LEAVE}/settings", headers=globex.headers())
    assert theirs.status_code == 200
    assert theirs.json()["leave_year_start_month"] != 4, (
        "Globex inherited Acme's leave-year policy"
    )


# --------------------------------------------------------------------------- #
# Part 3 — a foreign id is indistinguishable from one that does not exist
# --------------------------------------------------------------------------- #

#: ``(path template, seeded key, which of the tenant's people must ask)``. The
#: template takes exactly one ``{}``.
#:
#: The actor matters. ``/helpdesk/tickets/{id}`` is the *raiser's* view of their
#: own ticket and 404s for anyone else in the company — correctly, per D-026 —
#: so asking as the owner would prove nothing about tenancy.
BY_ID_READS = [
    (f"{ATT}/records/{{}}", "record_id", "owner"),
    (f"{LEAVE}/applications?user_id={{}}", "__employee__", "owner"),
    (f"{LEAVE}/balances?user_id={{}}", "__employee__", "owner"),
    (f"{LEAVE}/comp-offs?user_id={{}}", "__employee__", "owner"),
    (f"{ONB}/templates/{{}}", "template_id", "owner"),
    (f"{ONB}/instances/{{}}", "instance_id", "owner"),
    (f"{OFFB}/requests/{{}}", "offboarding_id", "owner"),
    (f"{OFFB}/requests/{{}}/assets", "offboarding_id", "owner"),
    (f"{ASSETS}/{{}}", "asset_id", "owner"),
    (f"{ASSETS}/{{}}/history", "asset_id", "owner"),
    (f"{HELP}/tickets/{{}}", "ticket_id", "employee"),
    (f"{HELP}/tickets/{{}}/source", "ticket_id", "employee"),
    (f"{HELP}/staff/tickets/{{}}", "ticket_id", "owner"),
    (f"{HELP}/staff/tickets/{{}}/source", "ticket_id", "owner"),
]

#: Collections addressed by somebody else's id rather than single rows.
#:
#: These answer ``200 []`` for an id outside the tenant, which is not a
#: disclosure — an empty list says nothing about whether the id exists — and
#: is the same answer they give for an id that exists nowhere. Held apart from
#: ``BY_ID_READS`` because "returns nothing" and "refuses" are different
#: correct answers, and asserting the wrong one of the two is how a test ends
#: up demanding a behaviour change that would make the endpoint worse.
SCOPED_COLLECTIONS = [
    (f"{ASSETS}/users/{{}}/history", "__employee__", "owner"),
]

_ID_READ_IDS = [template for template, _, _ in BY_ID_READS]


def _resolve(acme, acme_rows, key) -> str:
    return str(acme.employee.id) if key == "__employee__" else str(acme_rows[key])


def _as(tenant, actor: str) -> dict[str, str]:
    return tenant.headers(tenant.employee_token if actor == "employee" else None)


@pytest.mark.parametrize("template,key,actor", BY_ID_READS, ids=_ID_READ_IDS)
def test_a_foreign_id_reads_as_404_not_403(client, seeded, template, key, actor):
    """403 confirms the row exists. That confirmation is itself the disclosure.

    ``test_tenant_isolation.py`` makes the same point as "foreign and unknown
    must be indistinguishable"; stated here as the concrete status because 404
    is the only status that satisfies it in both directions — 403 for both
    would also refuse ids that genuinely do not exist, breaking every
    legitimate not-found path in the console.
    """
    acme, globex, acme_rows, _ = seeded
    response = client.get(
        template.format(_resolve(acme, acme_rows, key)), headers=_as(globex, actor)
    )
    assert response.status_code == 404, (
        f"{template} answered {response.status_code} for another tenant's id; "
        f"anything but 404 confirms the row exists"
    )


@pytest.mark.parametrize("template,key,actor", BY_ID_READS, ids=_ID_READ_IDS)
def test_a_foreign_id_and_an_unknown_id_are_indistinguishable(
    client, seeded, template, key, actor
):
    acme, globex, acme_rows, _ = seeded
    foreign = client.get(
        template.format(_resolve(acme, acme_rows, key)), headers=_as(globex, actor)
    ).status_code
    unknown = client.get(
        template.format(uuid.uuid4()), headers=_as(globex, actor)
    ).status_code
    assert foreign == unknown, (
        f"{template} answers {foreign} for a foreign id but {unknown} for an "
        f"unknown one — that difference enumerates the other tenant"
    )


@pytest.mark.parametrize("template,key,actor", BY_ID_READS, ids=_ID_READ_IDS)
def test_the_same_id_reads_fine_for_the_tenant_that_owns_it(
    client, seeded, template, key, actor
):
    """Otherwise an endpoint that 404s for everybody passes the two above."""
    acme, _, acme_rows, _ = seeded
    response = client.get(
        template.format(_resolve(acme, acme_rows, key)), headers=_as(acme, actor)
    )
    assert response.status_code == 200, (
        f"{template} refused the tenant that owns the row: {response.text[:200]}"
    )


@pytest.mark.parametrize(
    "template,key,actor", SCOPED_COLLECTIONS, ids=[t for t, _, _ in SCOPED_COLLECTIONS]
)
def test_a_collection_keyed_on_a_foreign_id_is_empty(client, seeded, template, key, actor):
    """Empty, and empty in the same way an id that exists nowhere is empty."""
    acme, globex, acme_rows, _ = seeded
    foreign = client.get(
        template.format(_resolve(acme, acme_rows, key)), headers=_as(globex, actor)
    )
    assert foreign.status_code == 200, foreign.text[:200]
    assert foreign.json() == [], (
        f"{template} returned another tenant's rows: {foreign.text[:300]}"
    )

    unknown = client.get(template.format(uuid.uuid4()), headers=_as(globex, actor))
    assert (unknown.status_code, unknown.json()) == (foreign.status_code, foreign.json()), (
        f"{template} distinguishes a foreign id from an unknown one"
    )


@pytest.mark.parametrize(
    "template,key,actor", SCOPED_COLLECTIONS, ids=[t for t, _, _ in SCOPED_COLLECTIONS]
)
def test_the_same_collection_is_populated_for_its_owner(client, seeded, template, key, actor):
    acme, _, acme_rows, _ = seeded
    response = client.get(
        template.format(_resolve(acme, acme_rows, key)), headers=_as(acme, actor)
    )
    assert response.status_code == 200, response.text[:200]
    assert response.json(), f"{template} is empty for the tenant that owns the rows"


# --------------------------------------------------------------------------- #
# Part 4 — cross-tenant writes are refused, and refused before they commit
# --------------------------------------------------------------------------- #


def _row(model, row_id):
    """Read a row back through a session no request has touched.

    The whole point of these assertions: a handler that raised 404 *after*
    mutating the session, or that committed and then refused, is invisible to
    a status-code check and catastrophic in production.
    """
    with SessionLocal() as db:
        return db.get(model, uuid.UUID(str(row_id)))


def test_a_foreign_leave_application_cannot_be_approved(client, seeded):
    acme, globex, acme_rows, _ = seeded
    response = client.post(
        f"{LEAVE}/applications/{acme_rows['leave_application_id']}/decision",
        json={"approve": True},
        headers=globex.headers(),
    )
    assert response.status_code == 404, response.text[:200]

    row = _row(LeaveApplication, acme_rows["leave_application_id"])
    assert row.status == "pending", "Globex decided an Acme leave application"
    assert row.reviewed_by_user_id is None
    assert row.debited_at is None, "a foreign approval reached the balance debit"


def test_a_foreign_regularization_cannot_be_approved(client, seeded):
    acme, globex, acme_rows, _ = seeded
    response = client.post(
        f"{REG}/{acme_rows['regularization_id']}/review",
        json={"status": "approved", "review_note": "fine by me"},
        headers=globex.headers(),
    )
    assert response.status_code == 404, response.text[:200]

    row = _row(RegularizationRequest, acme_rows["regularization_id"])
    assert row.status == "pending", "Globex approved an attendance correction at Acme"
    assert row.reviewed_by_user_id is None


def test_a_foreign_asset_cannot_be_assigned(client, seeded):
    """Two shapes of the same attack, because they fail in different places.

    Assigning a foreign asset to one's *own* employee is the one a naive
    ownership check on the user catches; assigning it to the foreign employee
    is the one a naive check on the asset catches. Both are refused, and
    afterwards the asset is still held by the person who actually has it.
    """
    acme, globex, acme_rows, globex_rows = seeded

    to_own = client.post(
        f"{ASSETS}/assign",
        json={"asset_id": acme_rows["asset_id"], "user_id": str(globex.employee.id)},
        headers=globex.headers(),
    )
    assert to_own.status_code == 404, to_own.text[:200]

    to_theirs = client.post(
        f"{ASSETS}/assign",
        json={"asset_id": acme_rows["asset_id"], "user_id": str(acme.employee.id)},
        headers=globex.headers(),
    )
    assert to_theirs.status_code == 404, to_theirs.text[:200]

    held_by = client.get(
        f"{ASSETS}/{acme_rows['asset_id']}", headers=acme.headers()
    ).json()
    assert held_by["current_holder_id"] == str(acme.employee.id)
    assert _row(Asset, acme_rows["asset_id"]).org_id == acme.id


def test_a_foreign_asset_cannot_be_returned_or_deleted(client, seeded):
    acme, globex, acme_rows, _ = seeded
    returned = client.post(
        f"{ASSETS}/{acme_rows['asset_id']}/return", json={}, headers=globex.headers()
    )
    assert returned.status_code == 404, returned.text[:200]

    deleted = client.delete(f"{ASSETS}/{acme_rows['asset_id']}", headers=globex.headers())
    assert deleted.status_code == 404, deleted.text[:200]

    asset = _row(Asset, acme_rows["asset_id"])
    assert asset is not None, "Globex deleted an Acme asset"
    assert asset.status == "assigned", "Globex closed an Acme custody assignment"


def test_a_foreign_ticket_cannot_be_commented_on(client, seeded):
    """Both doors, because they are different handlers with different gates."""
    acme, globex, acme_rows, _ = seeded

    as_employee = client.post(
        f"{HELP}/tickets/{acme_rows['ticket_id']}/comments",
        json={"body": "me too"},
        headers=globex.headers(globex.employee_token),
    )
    assert as_employee.status_code == 404, as_employee.text[:200]

    as_staff = client.post(
        f"{HELP}/staff/tickets/{acme_rows['ticket_id']}/comments",
        json={"body": "Escalating to legal.", "is_internal": True},
        headers=globex.headers(),
    )
    assert as_staff.status_code == 404, as_staff.text[:200]

    with SessionLocal() as db:
        bodies = db.scalars(
            select(HelpdeskComment.body).where(
                HelpdeskComment.ticket_id == uuid.UUID(acme_rows["ticket_id"])
            )
        ).all()
    assert "me too" not in bodies and "Escalating to legal." not in bodies, (
        "a Globex comment landed on an Acme ticket"
    )


def test_a_foreign_ticket_cannot_be_reassigned_or_resolved(client, seeded):
    acme, globex, acme_rows, _ = seeded

    assigned = client.post(
        f"{HELP}/staff/tickets/{acme_rows['ticket_id']}/assign",
        json={"assignee_id": str(globex.owner.id)},
        headers=globex.headers(),
    )
    assert assigned.status_code == 404, assigned.text[:200]

    resolved = client.post(
        f"{HELP}/staff/tickets/{acme_rows['ticket_id']}/resolve",
        json={},
        headers=globex.headers(),
    )
    assert resolved.status_code == 404, resolved.text[:200]

    ticket = _row(HelpdeskTicket, acme_rows["ticket_id"])
    assert ticket.status == "open"
    assert ticket.assigned_to != globex.owner.id, "an Acme ticket was assigned to a Globex user"


def test_a_foreign_offboarding_cannot_be_completed(client, seeded):
    """The highest-consequence write in the product.

    Completing an exit deactivates the person and revokes their devices. If
    this one crosses the tenant boundary, one company can log another
    company's staff out of their own laptops.
    """
    acme, globex, acme_rows, _ = seeded
    response = client.post(
        f"{OFFB}/requests/{acme_rows['offboarding_id']}/complete", headers=globex.headers()
    )
    assert response.status_code == 404, response.text[:200]

    exit_row = _row(OffboardingRequest, acme_rows["offboarding_id"])
    assert exit_row.status != "completed", "Globex completed an Acme exit"
    assert exit_row.completed_at is None

    employee = _row(User, acme.employee.id)
    assert employee.is_active, "an Acme employee was deactivated by Globex"


def test_a_foreign_offboarding_cannot_be_cancelled_or_edited(client, seeded):
    acme, globex, acme_rows, _ = seeded
    original = _row(OffboardingRequest, acme_rows["offboarding_id"]).last_working_day

    cancelled = client.post(
        f"{OFFB}/requests/{acme_rows['offboarding_id']}/cancel",
        json={"cancellation_reason": "Changed their mind"},
        headers=globex.headers(),
    )
    assert cancelled.status_code == 404, cancelled.text[:200]

    edited = client.patch(
        f"{OFFB}/requests/{acme_rows['offboarding_id']}",
        json={"last_working_day": (date.today() + timedelta(days=1)).isoformat()},
        headers=globex.headers(),
    )
    assert edited.status_code == 404, edited.text[:200]

    row = _row(OffboardingRequest, acme_rows["offboarding_id"])
    assert row.status == "initiated"
    assert row.last_working_day == original, "Globex moved an Acme last working day"


def test_a_foreign_onboarding_task_cannot_be_ticked_off(client, seeded):
    acme, globex, acme_rows, _ = seeded
    response = client.post(
        f"{ONB}/tasks/{acme_rows['onboarding_task_id']}/status",
        json={"status": "done"},
        headers=globex.headers(),
    )
    assert response.status_code == 404, response.text[:200]

    task = _row(OnboardingTask, acme_rows["onboarding_task_id"])
    assert task.status == "pending", "Globex completed an Acme onboarding task"
    assert task.completed_at is None


def test_a_foreign_onboarding_template_cannot_be_edited_or_deleted(client, seeded):
    acme, globex, acme_rows, _ = seeded
    edited = client.put(
        f"{ONB}/templates/{acme_rows['template_id']}",
        json={"name": "Renamed By Another Company"},
        headers=globex.headers(),
    )
    assert edited.status_code == 404, edited.text[:200]

    deleted = client.delete(
        f"{ONB}/templates/{acme_rows['template_id']}", headers=globex.headers()
    )
    assert deleted.status_code == 404, deleted.text[:200]

    template = _row(OnboardingTemplate, acme_rows["template_id"])
    assert template is not None, "Globex deleted an Acme onboarding template"
    assert template.name == "Standard Joiner"


def test_a_foreign_shift_cannot_be_edited_or_deleted(client, seeded):
    acme, globex, acme_rows, _ = seeded
    edited = client.patch(
        f"{ATT}/shifts/{acme_rows['shift_id']}",
        json={"name": "Night", "start_time": "22:00", "end_time": "06:00"},
        headers=globex.headers(),
    )
    assert edited.status_code == 404, edited.text[:200]

    deleted = client.delete(f"{ATT}/shifts/{acme_rows['shift_id']}", headers=globex.headers())
    assert deleted.status_code == 404, deleted.text[:200]

    shift = _row(Shift, acme_rows["shift_id"])
    assert shift is not None and shift.name == "General"


def test_a_foreign_office_location_cannot_be_moved(client, seeded):
    """Moving somebody else's geofence is a denial-of-service on their punches.

    D-014 guards the tenant's own admin against locking their company out. It
    says nothing about another company doing it to them, which is why this is
    asserted rather than assumed.
    """
    acme, globex, acme_rows, _ = seeded
    response = client.patch(
        f"{ATT}/locations/{acme_rows['location_id']}",
        json={"name": "Head Office", "lat": 0.0, "lng": 0.0},
        headers=globex.headers(),
    )
    assert response.status_code == 404, response.text[:200]

    location = _row(OfficeLocation, acme_rows["location_id"])
    assert (location.lat, location.lng) == (12.97, 77.59)


def test_a_foreign_holiday_cannot_be_deleted(client, seeded):
    acme, globex, acme_rows, _ = seeded
    response = client.delete(
        f"{LEAVE}/holidays/{acme_rows['holiday_id']}", headers=globex.headers()
    )
    assert response.status_code == 404, response.text[:200]
    assert _row(Holiday, acme_rows["holiday_id"]) is not None


def test_a_foreign_leave_balance_cannot_be_adjusted(client, seeded):
    """The one write that conjures entitlement out of nothing.

    Both directions are attempted: crediting a foreign leave type onto one's
    own employee, and crediting one's own type onto a foreign employee. A
    check on only one of the two ids would let the other through.
    """
    acme, globex, acme_rows, globex_rows = seeded

    foreign_type = client.post(
        f"{LEAVE}/balances/adjust",
        json={
            "user_id": str(globex.employee.id),
            "leave_type_id": acme_rows["leave_type_id"],
            "year": date.today().year,
            "delta_milli_days": 5_000,
            "reason": "Reaching across the boundary",
        },
        headers=globex.headers(),
    )
    assert foreign_type.status_code == 404, foreign_type.text[:200]

    foreign_user = client.post(
        f"{LEAVE}/balances/adjust",
        json={
            "user_id": str(acme.employee.id),
            "leave_type_id": globex_rows["leave_type_id"],
            "year": date.today().year,
            "delta_milli_days": 5_000,
            "reason": "Reaching across the boundary",
        },
        headers=globex.headers(),
    )
    assert foreign_user.status_code == 404, foreign_user.text[:200]

    balances = client.get(
        f"{LEAVE}/balances?user_id={acme.employee.id}", headers=acme.headers()
    ).json()
    assert all(row["accrued_milli_days"] <= 10_000 for row in balances), (
        "Globex credited leave onto an Acme employee"
    )


def test_a_foreign_employee_cannot_be_put_on_a_shift(client, seeded):
    """The rota write takes two ids, and both must be checked."""
    acme, globex, acme_rows, globex_rows = seeded

    foreign_user = client.post(
        f"{ATT}/shift-assignments",
        json={
            "user_id": str(acme.employee.id),
            "shift_id": globex_rows["shift_id"],
            "effective_from": date.today().isoformat(),
        },
        headers=globex.headers(),
    )
    assert foreign_user.status_code == 404, foreign_user.text[:200]

    foreign_shift = client.post(
        f"{ATT}/shift-assignments",
        json={
            "user_id": str(globex.employee.id),
            "shift_id": acme_rows["shift_id"],
            "effective_from": date.today().isoformat(),
        },
        headers=globex.headers(),
    )
    assert foreign_shift.status_code == 404, foreign_shift.text[:200]

    with SessionLocal() as db:
        rows = db.scalars(
            select(ShiftAssignment).where(ShiftAssignment.user_id == acme.employee.id)
        ).all()
        assert all(row.org_id == acme.id for row in rows), (
            "a Globex rota row was written against an Acme employee"
        )


def test_a_foreign_exit_cannot_be_opened_against_someone(client, seeded):
    """Opening an exit for another company's employee, not just editing one."""
    acme, globex, _, _ = seeded
    response = client.post(
        f"{OFFB}/requests",
        json={
            "user_id": str(acme.employee.id),
            "reason": "termination",
            "notice_date": date.today().isoformat(),
        },
        headers=globex.headers(),
    )
    assert response.status_code == 404, response.text[:200]

    with SessionLocal() as db:
        rows = db.scalars(
            select(OffboardingRequest).where(OffboardingRequest.user_id == acme.employee.id)
        ).all()
    assert all(row.org_id == acme.id for row in rows), (
        "Globex opened an exit against an Acme employee"
    )


def test_a_ticket_cannot_be_back_linked_to_another_tenants_row(client, seeded):
    """D-019's probe, taken across the tenant boundary.

    ``source_ref`` is deliberately not a foreign key, so nothing in the schema
    stops a ticket pointing at another company's regularization. The write is
    what has to refuse it: an unchecked ref turns the ticket form into an
    existence oracle — one ticket per guessed UUID, the answer read off the
    rendered link — and that probe is worth more to an attacker across the
    tenant boundary than inside one.
    """
    acme, globex, acme_rows, _ = seeded
    response = client.post(
        f"{HELP}/tickets",
        json={
            "subject": "Dispute",
            "description": "Please review.",
            "source_module": "regularization",
            "source_ref": acme_rows["regularization_id"],
        },
        headers=globex.headers(globex.employee_token),
    )
    assert response.status_code == 422, (
        f"Globex stored a link to an Acme regularization: {response.text[:300]}"
    )
    # Same message a nonexistent id gets, or the refusal is itself the oracle.
    unknown = client.post(
        f"{HELP}/tickets",
        json={
            "subject": "Dispute",
            "description": "Please review.",
            "source_module": "regularization",
            "source_ref": str(uuid.uuid4()),
        },
        headers=globex.headers(globex.employee_token),
    )
    assert (unknown.status_code, unknown.json()) == (response.status_code, response.json()), (
        "a foreign source_ref is refused differently from an unknown one"
    )

    with SessionLocal() as db:
        refs = db.scalars(select(HelpdeskTicket.source_ref)).all()
    assert uuid.UUID(acme_rows["regularization_id"]) not in [r for r in refs if r], (
        "an Acme regularization id was stored on a ticket somewhere"
    )


def test_a_foreign_onboarding_document_cannot_be_downloaded(client, seeded):
    """A stored file is the one thing a leak cannot be walked back.

    Every other endpoint in this file discloses a row. This one discloses a
    scan of somebody's passport, and the bytes are gone the moment they are
    served — so the download, the verification and the delete are all checked
    rather than assumed to inherit the instance's scoping.
    """
    acme, globex, acme_rows, _ = seeded
    uploaded = client.post(
        f"{ONB}/instances/{acme_rows['instance_id']}/documents",
        data={"meta": '{"doc_type": "pan"}'},
        files={"file": ("pan.txt", b"ACME-CONFIDENTIAL", "text/plain")},
        headers=acme.headers(),
    )
    assert uploaded.status_code == 201, uploaded.text[:300]
    document_id = uploaded.json()["id"]

    served = client.get(f"{ONB}/documents/{document_id}/file", headers=globex.headers())
    assert served.status_code == 404, (
        f"Globex downloaded an Acme document: {served.status_code}"
    )
    assert b"ACME-CONFIDENTIAL" not in served.content

    unknown = client.get(f"{ONB}/documents/{uuid.uuid4()}/file", headers=globex.headers())
    assert unknown.status_code == served.status_code

    verified = client.post(
        f"{ONB}/documents/{document_id}/verify",
        json={"is_verified": True},
        headers=globex.headers(),
    )
    assert verified.status_code == 404, verified.text[:200]

    deleted = client.delete(f"{ONB}/documents/{document_id}", headers=globex.headers())
    assert deleted.status_code == 404, deleted.text[:200]

    with SessionLocal() as db:
        row = db.scalar(
            select(OnboardingDocument).where(
                OnboardingDocument.id == uuid.UUID(document_id)
            )
        )
    assert row is not None, "Globex deleted an Acme onboarding document"
    assert not row.is_verified, "Globex verified an Acme onboarding document"

    mine = client.get(f"{ONB}/documents/{document_id}/file", headers=acme.headers())
    assert mine.status_code == 200 and b"ACME-CONFIDENTIAL" in mine.content


def test_a_foreign_settlement_cannot_be_recorded_or_amended(client, seeded):
    """Money, and the only table in the product that holds a payable amount."""
    acme, globex, acme_rows, _ = seeded
    created = client.post(
        f"{OFFB}/requests/{acme_rows['offboarding_id']}/fnf",
        json={"gross_dues_paise": 10_000_00, "net_payable_paise": 10_000_00},
        headers=globex.headers(),
    )
    assert created.status_code == 404, created.text[:200]

    # And once the settlement genuinely exists, it cannot be amended either.
    real = client.post(
        f"{OFFB}/requests/{acme_rows['offboarding_id']}/fnf",
        json={"gross_dues_paise": 10_000_00, "net_payable_paise": 10_000_00},
        headers=acme.headers(),
    )
    assert real.status_code == 201, real.text[:300]

    amended = client.patch(
        f"{OFFB}/requests/{acme_rows['offboarding_id']}/fnf",
        json={"net_payable_paise": 1, "status": "paid"},
        headers=globex.headers(),
    )
    assert amended.status_code == 404, amended.text[:200]

    with SessionLocal() as db:
        row = db.scalar(
            select(OffboardingFnf).where(
                OffboardingFnf.request_id == uuid.UUID(acme_rows["offboarding_id"])
            )
        )
    assert row.net_payable_paise == 10_000_00, "Globex rewrote an Acme settlement"
    assert row.status != "paid", "Globex marked an Acme settlement paid"


def test_recomputing_attendance_stops_at_the_tenant_boundary(client, seeded):
    """The one endpoint that rewrites rows in bulk.

    It takes a date range and no org — the org comes from the token — so the
    thing to prove is that a neighbouring tenant running it over the same
    range leaves this tenant's rows exactly as they were.
    """
    acme, globex, acme_rows, _ = seeded
    yesterday = date.today() - timedelta(days=1)

    def acme_rows_now():
        with SessionLocal() as db:
            return {
                (row.id, row.status, row.worked_minutes)
                for row in db.scalars(
                    select(AttendanceRecord).where(AttendanceRecord.org_id == acme.id)
                ).all()
            }

    before = acme_rows_now()
    response = client.post(
        f"{ATT}/recompute?start={(yesterday - timedelta(days=7)).isoformat()}"
        f"&end={yesterday.isoformat()}",
        headers=globex.headers(),
    )
    assert response.status_code == 200, response.text[:200]
    assert acme_rows_now() == before, "a Globex recompute rewrote Acme attendance rows"


# --------------------------------------------------------------------------- #
# Part 4b — a foreign id smuggled into an otherwise-legitimate write
# --------------------------------------------------------------------------- #

#: ``(label, method, path template, body)`` — every write in the seven modules
#: that takes an id in its *body* rather than its URL.
#:
#: This is the shape of cross-tenant write that a URL-scoped check does not
#: catch. The request is entirely legitimate — the caller's own token, their
#: own tenant's host, a row they own in the path — and one field inside the
#: body names a row belonging to somebody else. A handler that scopes the
#: resource it is editing and then trusts the body has a hole exactly this
#: wide, and the resulting row is worse than a leak: it is one tenant's table
#: holding a live pointer into another's.
FOREIGN_ID_IN_BODY = [
    (
        "a foreign user as the assignee of an own ticket",
        "post", f"{HELP}/staff/tickets/{{own_ticket}}/assign",
        {"assignee_id": "{their_user}"},
    ),
    (
        "a foreign category on an own ticket",
        "post", f"{HELP}/tickets",
        {"subject": "x", "description": "y", "category_id": "{their_category}"},
    ),
    (
        "a foreign template behind an own onboarding instance",
        "post", f"{ONB}/instances",
        {"user_id": "{own_owner}", "template_id": "{their_template}"},
    ),
    (
        "a foreign user as the assignee of an own onboarding task",
        "post", f"{ONB}/instances/{{own_instance}}/tasks",
        {"title": "T", "assignee_user_id": "{their_user}"},
    ),
    (
        "a foreign user as the assignee of an own clearance task",
        "post", f"{OFFB}/requests/{{own_offboarding}}/tasks",
        {"title": "T", "category": "hr_clearance", "assignee_user_id": "{their_user}"},
    ),
    (
        "a foreign leave type on an own application",
        "post", f"{LEAVE}/applications",
        {"leave_type_id": "{their_leave_type}", "start_date": "{soon}", "end_date": "{soon}"},
    ),
    (
        "a foreign employee granted an own comp-off",
        "post", f"{LEAVE}/comp-offs",
        {
            "user_id": "{their_user}", "earned_date": "{recently}",
            "credit_milli_days": 1000, "reason": "worked a weekend",
        },
    ),
    (
        "a foreign employee handed an own asset",
        "post", f"{ASSETS}/assign",
        {"asset_id": "{own_asset}", "user_id": "{their_user}"},
    ),
]


def _acme_ids(acme, acme_rows) -> list[uuid.UUID]:
    return [uuid.UUID(str(value)) for value in acme_rows.values()] + [
        acme.id, acme.owner.id, acme.employee.id
    ]


def _pointers_from(org_id: uuid.UUID, foreign: list[uuid.UUID]) -> list[tuple[str, str]]:
    """Every ``(table, column)`` in ``org_id``'s rows that names a foreign id.

    Swept across the whole schema rather than the table the write targeted,
    because the interesting version of this bug writes somewhere adjacent — an
    audit row, a ledger row, a task the service created on the way — and a
    check aimed at the obvious table would miss it.
    """
    found: list[tuple[str, str]] = []
    with SessionLocal() as db:
        for table in Base.metadata.sorted_tables:
            if "org_id" not in table.c:
                continue
            for column in table.c:
                if column.name == "org_id" or not isinstance(column.type, Uuid):
                    continue
                hit = db.execute(
                    table.select().where(table.c.org_id == org_id, column.in_(foreign))
                ).first()
                if hit is not None:
                    found.append((table.name, column.name))
    return found


def _fill(value, context):
    if isinstance(value, str):
        return value.format(**context)
    if isinstance(value, dict):
        return {key: _fill(item, context) for key, item in value.items()}
    return value


@pytest.mark.parametrize(
    "label,method,template,body", FOREIGN_ID_IN_BODY, ids=[c[0] for c in FOREIGN_ID_IN_BODY]
)
def test_a_foreign_id_in_the_body_is_refused(client, seeded, label, method, template, body):
    """404, and no row anywhere ends up pointing across the boundary.

    Asserted as 404 rather than 422 for the same reason as part 3: a distinct
    "that id is not yours" would confirm the id exists, and these bodies are
    the cheapest place in the product to run that probe — nothing has to exist
    beforehand, so an attacker can iterate ids as fast as they can POST.
    """
    acme, globex, acme_rows, globex_rows = seeded
    context = {
        "own_ticket": globex_rows["ticket_id"],
        "own_instance": globex_rows["instance_id"],
        "own_offboarding": globex_rows["offboarding_id"],
        "own_asset": globex_rows["asset_id"],
        "own_owner": str(globex.owner.id),
        "their_user": str(acme.employee.id),
        "their_category": acme_rows["category_id"],
        "their_template": acme_rows["template_id"],
        "their_leave_type": acme_rows["leave_type_id"],
        "soon": _next_weekday(21).isoformat(),
        "recently": (date.today() - timedelta(days=5)).isoformat(),
    }
    response = getattr(client, method)(
        template.format(**context),
        json=_fill(body, context),
        headers=globex.headers(),
    )
    assert response.status_code == 404, (
        f"{label}: answered {response.status_code} — {response.text[:300]}"
    )

    assert _pointers_from(globex.id, _acme_ids(acme, acme_rows)) == [], (
        f"{label}: a Globex row now points at an Acme one"
    )


def test_the_stray_pointer_sweep_can_actually_find_one(client, seeded):
    """A positive control for the sweep the eight tests above rely on.

    A search that always returns nothing passes every one of them while
    proving nothing, and this one is easy to break silently — a column type
    that stops being ``Uuid``, a table without ``org_id``. So a stray is
    planted deliberately and the sweep is required to name it.
    """
    acme, globex, acme_rows, globex_rows = seeded
    foreign = _acme_ids(acme, acme_rows)
    assert _pointers_from(globex.id, foreign) == []

    with SessionLocal() as db:
        ticket = db.get(HelpdeskTicket, uuid.UUID(globex_rows["ticket_id"]))
        ticket.assigned_to = acme.owner.id
        db.commit()

    assert ("helpdesk_tickets", "assigned_to") in _pointers_from(globex.id, foreign)


def test_an_optional_holiday_belongs_to_one_tenants_calendar(client, seeded):
    """The opt-in table is keyed on ``(user_id, holiday_id)`` with no org in it.

    That is correct — both ids are already tenant-bound — but it means the only
    thing standing between an employee and another company's holiday calendar
    is the service's own check, so it is asserted rather than inferred from the
    constraint.
    """
    acme, globex, _, _ = seeded
    when = _next_weekday(75).isoformat()
    theirs = client.post(
        f"{LEAVE}/holidays",
        json={"holiday_date": when, "name": "Optional Day", "is_optional": True},
        headers=acme.headers(),
    )
    assert theirs.status_code == 201, theirs.text[:200]

    refused = client.put(
        f"{LEAVE}/holidays/opt-ins",
        json={"holiday_ids": [theirs.json()["id"]]},
        headers=globex.headers(globex.employee_token),
    )
    assert refused.status_code in (404, 422), refused.text[:200]

    # The refusal must be about tenancy and not about the payload: the same
    # request against Globex's own optional holiday has to succeed, or this
    # test would pass on a validator that rejects every opt-in.
    ours = client.post(
        f"{LEAVE}/holidays",
        json={"holiday_date": when, "name": "Optional Day", "is_optional": True},
        headers=globex.headers(),
    )
    assert ours.status_code == 201, ours.text[:200]
    accepted = client.put(
        f"{LEAVE}/holidays/opt-ins",
        json={"holiday_ids": [ours.json()["id"]]},
        headers=globex.headers(globex.employee_token),
    )
    assert accepted.status_code == 200, accepted.text[:300]
    assert [row["holiday_id"] for row in accepted.json()] == [ours.json()["id"]]


# --------------------------------------------------------------------------- #
# Part 5 — a token minted for one tenant is refused on another's host
# --------------------------------------------------------------------------- #

#: Every read in part 2 plus the settings singletons — the surface a stolen
#: token would be replayed against.
HOST_MISMATCH_PATHS = LIST_ENDPOINTS + [
    f"{ATT}/me/today",
    f"{ATT}/settings",
    f"{LEAVE}/settings",
    f"{ONB}/my",
]


@pytest.mark.parametrize("path", HOST_MISMATCH_PATHS)
def test_a_token_from_one_tenant_is_refused_on_anothers_host(client, tenants, path):
    """``deps.get_current_user``'s second check, exercised on the HRMS surface.

    Every handler below it also filters on ``org_id``; this is the belt to that
    pair of braces, and the one that holds when a single handler forgets.
    """
    acme, globex = tenants
    response = client.get(path, headers={
        "Authorization": f"Bearer {acme.owner_token}",
        "X-Org-Slug": globex.slug,
    })
    assert response.status_code in (401, 403), (
        f"{path} accepted an Acme token on the Globex host: {response.status_code}"
    )


def test_a_token_from_one_tenant_is_refused_on_anothers_host_for_valid_ids(client, seeded):
    """The dangerous case: the ids in the URL are real *for the token's tenant*.

    A handler that resolved the row before checking the host would serve it,
    because everything it looked at agrees with itself. Only the
    ``user.org_id != tenant.id`` check catches this.
    """
    acme, globex, acme_rows, _ = seeded
    for template, key, actor in BY_ID_READS + SCOPED_COLLECTIONS:
        token = acme.employee_token if actor == "employee" else acme.owner_token
        path = template.format(_resolve(acme, acme_rows, key))
        response = client.get(path, headers={
            "Authorization": f"Bearer {token}",
            "X-Org-Slug": globex.slug,
        })
        assert response.status_code in (401, 403), (
            f"{path} served an Acme row to an Acme token pointed at the Globex host: "
            f"{response.status_code}"
        )


def test_a_cross_host_token_cannot_write_either(client, seeded):
    """Reads are the disclosure; writes are the damage. Both are refused."""
    acme, globex, acme_rows, _ = seeded
    response = client.post(
        f"{LEAVE}/applications/{acme_rows['leave_application_id']}/decision",
        json={"approve": True},
        headers={
            "Authorization": f"Bearer {acme.owner_token}",
            "X-Org-Slug": globex.slug,
        },
    )
    assert response.status_code in (401, 403), response.status_code
    assert _row(LeaveApplication, acme_rows["leave_application_id"]).status == "pending"


@pytest.mark.parametrize("path", HOST_MISMATCH_PATHS)
def test_anonymous_access_to_the_hrms_surface_is_refused(client, tenants, path):
    acme, _ = tenants
    response = client.get(path, headers={"X-Org-Slug": acme.slug})
    assert response.status_code in (401, 403)


@pytest.mark.parametrize("path", HOST_MISMATCH_PATHS)
def test_a_platform_token_is_not_an_hrms_user(client, tenants, platform_token, path):
    """A super-admin token must not double as a tenant identity.

    The platform console has its own endpoints. If an operator's token were
    accepted here it would be accepted at *every* tenant, which is a single
    credential that reads the whole platform's HR data.
    """
    acme, _ = tenants
    response = client.get(path, headers={
        "Authorization": f"Bearer {platform_token}",
        "X-Org-Slug": acme.slug,
    })
    assert response.status_code in (401, 403), (
        f"{path} accepted a platform token as a tenant user: {response.status_code}"
    )


# --------------------------------------------------------------------------- #
# Part 6 — the second company to onboard must not be blocked by the first
# --------------------------------------------------------------------------- #


def test_two_tenants_can_use_the_same_names(client, tenants):
    """Every natural key an HRMS admin types, claimed by both companies.

    "Casual", "General", "LAP-001", "Head Office", "Payroll", "Standard
    Joiner" are not creative names — they are the names *everyone* picks. A
    global unique index on any of them would make the second customer's first
    hour on the product a support ticket, and the fix would be a schema change
    under a live table.
    """
    acme, globex = tenants
    shared = [
        (f"{ATT}/locations", {"name": "Head Office", "lat": 12.97, "lng": 77.59}),
        (f"{ATT}/shifts", {"name": "General"}),
        (f"{LEAVE}/types", {"name": "Casual", "code": "CL", "accrual_type": "none"}),
        (
            f"{LEAVE}/holidays",
            {"holiday_date": _next_weekday(60).isoformat(), "name": "Republic Day"},
        ),
        (ASSETS, {"asset_tag": "LAP-001", "category": "laptop"}),
        (f"{HELP}/categories", {"name": "Payroll"}),
        (f"{ONB}/templates", {"name": "Standard Joiner"}),
    ]

    for path, body in shared:
        first = client.post(path, json=body, headers=acme.headers())
        assert first.status_code == 201, f"{path} (first tenant): {first.text[:200]}"
        second = client.post(path, json=body, headers=globex.headers())
        assert second.status_code == 201, (
            f"{path} refused Globex a name Acme already used — the unique "
            f"constraint is global, not per-org: {second.text[:300]}"
        )
        assert first.json()["id"] != second.json()["id"]


def test_a_name_is_still_unique_inside_one_tenant(client, tenants):
    """The other half. Per-org must not have been achieved by dropping the
    constraint altogether — one company with two shifts called "General" is a
    rota nobody can read."""
    acme, _ = tenants
    first = client.post(f"{ATT}/shifts", json={"name": "General"}, headers=acme.headers())
    assert first.status_code == 201, first.text
    second = client.post(f"{ATT}/shifts", json={"name": "General"}, headers=acme.headers())
    assert second.status_code in (400, 409, 422), (
        f"Acme created two shifts called General: {second.status_code}"
    )


def test_both_tenants_can_hold_the_same_asset_tag_at_once(client, tenants):
    """The tag collision that only shows up once custody is involved.

    The register's unique key is per-org; the *assignment* ledger's is scoped
    by ``asset_id``. Two companies each issuing their own LAP-001 exercises
    both at once, which a two-row register test does not.
    """
    acme, globex = tenants
    holders = {}
    for tenant in (acme, globex):
        asset = client.post(
            ASSETS, json={"asset_tag": "LAP-001", "category": "laptop"},
            headers=tenant.headers(),
        )
        assert asset.status_code == 201, asset.text
        assigned = client.post(
            f"{ASSETS}/assign",
            json={"asset_id": asset.json()["id"], "user_id": str(tenant.employee.id)},
            headers=tenant.headers(),
        )
        assert assigned.status_code == 201, (
            f"{tenant.slug} could not issue LAP-001 while the other tenant holds "
            f"one: {assigned.text[:300]}"
        )
        holders[tenant.slug] = assigned.json()["id"]

    assert holders[acme.slug] != holders[globex.slug]

    mine = client.get(f"{ASSETS}/my", headers=globex.headers(globex.employee_token))
    assert mine.status_code == 200
    assert [row["asset_tag"] for row in mine.json()] == ["LAP-001"]
    assert len(mine.json()) == 1, "an employee sees both tenants' LAP-001"


def test_both_tenants_can_have_an_open_exit_for_the_same_kind_of_person(client, tenants):
    """``uq_offboarding_requests_open_per_user`` is partial and scoped by user.

    Asserted because a constraint written as "one open exit" rather than "one
    open exit per user" would let the first company in the database open one
    and block everybody else's forever.
    """
    acme, globex = tenants
    for tenant in (acme, globex):
        response = client.post(
            f"{OFFB}/requests",
            json={
                "user_id": str(tenant.employee.id),
                "reason": "resignation",
                "notice_date": date.today().isoformat(),
            },
            headers=tenant.headers(),
        )
        assert response.status_code == 201, (
            f"{tenant.slug} could not open an exit: {response.text[:300]}"
        )


def test_both_tenants_can_file_a_regularization_for_the_same_day(client, tenants):
    """The same calendar day, filed by two companies at once.

    ``uq_regularization_pending_day`` is a partial unique index on
    ``(org_id, user_id, date) WHERE status = 'pending'`` (D-005), and the
    structural test above cannot tell that apart from a version without the
    ``org_id`` — ``user_id`` alone would satisfy its rooting rule, correctly,
    because a user already belongs to one tenant. What this catches is the
    layer the schema cannot speak for: a service-side duplicate check that
    looked the day up without an org filter and refused the second company's
    perfectly ordinary Tuesday.
    """
    acme, globex = tenants
    when = date.today() - timedelta(days=2)
    corrected = datetime.now(timezone.utc) - timedelta(days=2)
    for tenant in (acme, globex):
        response = client.post(
            REG,
            json={
                "date": when.isoformat(),
                "requested_check_in": corrected.replace(hour=9, minute=0).isoformat(),
                "requested_check_out": corrected.replace(hour=18, minute=0).isoformat(),
                "reason": "Badge reader was down at the gate.",
            },
            headers=tenant.headers(tenant.employee_token),
        )
        assert response.status_code == 201, (
            f"{tenant.slug} could not file for {when}: {response.text[:300]}"
        )
