"""Endpoints must report what actually happened.

The audit found three deletes returning 204 for rows they never touched. The
data was safe — the queries were correctly scoped — but an API that says "done"
when it did nothing hides the difference between a working authorisation check
and a broken one, which is exactly the confusion it caused during the audit.
"""

from __future__ import annotations

import uuid


def _add_rule(client, tenant, pattern="example.com"):
    response = client.post(
        "/api/v1/admin/rules",
        json={"match_type": "domain", "pattern": pattern, "productivity": "unproductive"},
        headers=tenant.headers(),
    )
    assert response.status_code in (200, 201), response.text
    return response.json()["id"]


def test_deleting_a_rule_that_exists_succeeds(client, tenants):
    acme, _ = tenants
    rule_id = _add_rule(client, acme)
    assert client.delete(f"/api/v1/admin/rules/{rule_id}", headers=acme.headers()).status_code == 204


def test_deleting_a_rule_twice_reports_the_second_as_missing(client, tenants):
    acme, _ = tenants
    rule_id = _add_rule(client, acme)
    client.delete(f"/api/v1/admin/rules/{rule_id}", headers=acme.headers())
    again = client.delete(f"/api/v1/admin/rules/{rule_id}", headers=acme.headers())
    assert again.status_code == 404


def test_deleting_an_unknown_rule_is_a_404(client, tenants):
    acme, _ = tenants
    response = client.delete(f"/api/v1/admin/rules/{uuid.uuid4()}", headers=acme.headers())
    assert response.status_code == 404


def test_deleting_another_tenants_rule_is_refused_and_leaves_it_alone(client, tenants):
    """The case that made this look like a breach during the audit: a 204 for
    a rule belonging to a different company, which was never actually deleted."""
    acme, globex = tenants
    rule_id = _add_rule(client, acme, "acme-only.example")

    response = client.delete(f"/api/v1/admin/rules/{rule_id}", headers=globex.headers())
    assert response.status_code == 404

    still_there = client.get("/api/v1/admin/rules", headers=acme.headers()).json()
    assert any(r["id"] == rule_id for r in still_there)


def test_health_needs_no_authentication(client):
    """Load balancers cannot log in."""
    assert client.get("/health").status_code == 200
