"""Per-company module grants -- the Super Admin override layered over the plan.

The four questions this file exists to answer, because getting any of them wrong
gives a customer a module they did not buy or takes away one they did:

1. With no grant, a company follows its plan (and an empty plan means *all*).
2. A grant of ``false`` revokes a module the plan includes.
3. A grant of ``true`` adds a module the plan omits -- the whole point of the
   feature, since it is what lets one negotiated customer get one extra module
   without a bespoke plan nobody else is on.
4. Clearing a grant returns the module to the plan's control, rather than
   pinning it to whatever it happened to be last.

Every assertion goes through the real HTTP surface. A unit test on
``allows_module`` would pass while the router was still ungated, which is the
failure that actually matters.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.core.modules import GRANTABLE_KEYS
from app.db.session import SessionLocal
from app.models import Organization, PlanRecord, Subscription


def platform_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _put_grants(client, token, org_id, grants: list[dict]):
    return client.put(
        f"/api/v1/platform/companies/{org_id}/modules",
        json={"grants": grants},
        headers=platform_headers(token),
    )


def _restrict_plan(org_id, modules: list[str]) -> None:
    """Put this company on a plan that includes only ``modules``.

    Written against the database rather than the plan API because the point is
    the *interaction* between a restrictive plan and a grant; building the plan
    through its own endpoints would test the plan editor twice and this once.
    """
    with SessionLocal() as db:
        plan = db.scalar(select(PlanRecord).where(PlanRecord.id == "restricted"))
        if plan is None:
            plan = PlanRecord(
                id="restricted",
                name="Restricted",
                base_price_annual=0,
                per_employee_month=0,
                min_employees=1,
                max_employees=50,
                max_screenshot_retention_days=30,
                max_activity_retention_days=30,
                min_screenshot_interval_s=60,
                storage_gb=10,
                features=[],
                modules=modules,
            )
            db.add(plan)
        else:
            plan.modules = modules
        sub = db.scalar(select(Subscription).where(Subscription.org_id == org_id))
        if sub is None:
            # The `tenants` fixture makes no subscription, so an unsubscribed
            # company resolves to the trial plan -- which has an empty module
            # list and therefore allows everything. Creating one here is what
            # makes "the plan restricts this" an actual precondition rather than
            # a no-op the test would then pass for the wrong reason.
            sub = Subscription(org_id=org_id, seats=5)
            db.add(sub)
        sub.plan_id = "restricted"
        sub.status = "active"
        sub.period_end = datetime.now(timezone.utc) + timedelta(days=30)
        db.commit()

    from app.services import plancatalog

    with SessionLocal() as db:
        plancatalog.refresh(db)


# --------------------------------------------------------------------------- #
# The registry
# --------------------------------------------------------------------------- #


def test_registry_lists_every_grantable_module(client_raising, platform_token):
    body = client_raising.get(
        "/api/v1/platform/modules", headers=platform_headers(platform_token)
    ).json()
    keys = [m["key"] for m in body]
    assert set(GRANTABLE_KEYS) <= set(keys)
    # Every entry carries what the panel renders. A module that registered
    # without a label shows up as a raw slug, which is the silent half-shipped
    # state the registry exists to make impossible.
    for entry in body:
        assert entry["label"] and entry["description"] and entry["group"]


# --------------------------------------------------------------------------- #
# Reading a company's state
# --------------------------------------------------------------------------- #


def test_unrestricted_plan_enables_everything_via_plan(client_raising, tenants, platform_token):
    acme, _ = tenants
    body = client_raising.get(
        f"/api/v1/platform/companies/{acme.id}/modules",
        headers=platform_headers(platform_token),
    ).json()
    assert body["plan_unrestricted"] is True
    for module in body["modules"]:
        if module["grantable"]:
            assert module["enabled"] is True
            # Enabled *because of the plan*, not because of a grant -- the
            # distinction the panel renders and an operator acts on.
            assert module["source"] == "plan"
            assert module["override"] is None


# --------------------------------------------------------------------------- #
# Granting and revoking
# --------------------------------------------------------------------------- #


def test_revoking_a_module_blocks_its_routes(client, tenants, platform_token):
    acme, _ = tenants
    assert client.get("/api/v1/leave/types", headers=acme.headers()).status_code == 200

    _put_grants(client, platform_token, acme.id, [{"key": "leave", "enabled": False}])

    blocked = client.get("/api/v1/leave/types", headers=acme.headers())
    assert blocked.status_code == 402
    detail = blocked.json()["detail"]
    # A typed reason, so the console can offer "upgrade" rather than parse prose.
    assert detail["reason"] == "module_not_in_plan"
    assert detail["module"] == "leave"


def test_granting_adds_a_module_the_plan_omits(client, tenants, platform_token):
    acme, _ = tenants
    _restrict_plan(acme.id, ["attendance"])

    # Baseline: the restrictive plan really does block it.
    assert client.get("/api/v1/assets", headers=acme.headers()).status_code == 402

    _put_grants(client, platform_token, acme.id, [{"key": "assets", "enabled": True}])
    assert client.get("/api/v1/assets", headers=acme.headers()).status_code == 200


def test_clearing_a_grant_returns_control_to_the_plan(client, tenants, platform_token):
    acme, _ = tenants
    _restrict_plan(acme.id, ["attendance"])
    _put_grants(client, platform_token, acme.id, [{"key": "assets", "enabled": True}])
    assert client.get("/api/v1/assets", headers=acme.headers()).status_code == 200

    # An empty submit clears every override -- "inherit" is stored as absence.
    _put_grants(client, platform_token, acme.id, [])
    assert client.get("/api/v1/assets", headers=acme.headers()).status_code == 402

    with SessionLocal() as db:
        org = db.get(Organization, acme.id)
        assert org.module_grants == {}


def test_grant_of_none_is_inherit_not_off(client, tenants, platform_token):
    acme, _ = tenants
    _restrict_plan(acme.id, ["assets"])
    # enabled omitted entirely: this must not be read as False and must not
    # store anything, or an operator clearing a switch would silently revoke.
    _put_grants(client, platform_token, acme.id, [{"key": "assets"}])
    assert client.get("/api/v1/assets", headers=acme.headers()).status_code == 200
    with SessionLocal() as db:
        assert db.get(Organization, acme.id).module_grants == {}


# --------------------------------------------------------------------------- #
# Isolation and validation
# --------------------------------------------------------------------------- #


def test_a_grant_touches_only_its_own_company(client, tenants, platform_token):
    acme, globex = tenants
    _put_grants(client, platform_token, acme.id, [{"key": "leave", "enabled": False}])
    assert client.get("/api/v1/leave/types", headers=acme.headers()).status_code == 402
    assert client.get("/api/v1/leave/types", headers=globex.headers()).status_code == 200


def test_unknown_module_key_is_refused(client, tenants, platform_token):
    acme, _ = tenants
    response = _put_grants(client, platform_token, acme.id, [{"key": "assests", "enabled": True}])
    assert response.status_code == 422
    with SessionLocal() as db:
        assert db.get(Organization, acme.id).module_grants == {}


def test_grants_require_a_platform_admin(client, tenants):
    acme, _ = tenants
    # A company owner is the most privileged tenant role there is, and still
    # must not be able to grant their own company a module they did not buy.
    response = client.put(
        f"/api/v1/platform/companies/{acme.id}/modules",
        json={"grants": [{"key": "leave", "enabled": True}]},
        headers=acme.headers(),
    )
    assert response.status_code in (401, 403)


# --------------------------------------------------------------------------- #
# What the tenant console reads
# --------------------------------------------------------------------------- #


def test_console_sees_the_same_answer_as_the_gate(client, tenants, platform_token):
    acme, _ = tenants
    _put_grants(client, platform_token, acme.id, [{"key": "helpdesk", "enabled": False}])

    body = client.get("/api/v1/org/modules", headers=acme.headers()).json()
    assert "helpdesk" not in body["enabled"]
    assert body["modules"]["helpdesk"]["enabled"] is False
    # in_plan stays true: the plan does include it, an operator switched it off.
    # The billing page needs that difference to word its message correctly.
    assert body["modules"]["helpdesk"]["in_plan"] is True
    assert client.get("/api/v1/helpdesk/tickets", headers=acme.headers()).status_code == 402


def test_module_list_needs_authentication(client, tenants):
    acme, _ = tenants
    # Which modules a company bought is commercial information about that
    # company; an anonymous caller who can guess a slug must not learn it.
    response = client.get("/api/v1/org/modules", headers={"X-Org-Slug": acme.slug})
    assert response.status_code == 401
