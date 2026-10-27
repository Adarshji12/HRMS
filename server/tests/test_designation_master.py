"""Designation Master: level 1 is the most senior, titles can be tied to a
department, and a title can be edited in place."""

from __future__ import annotations


def _designations(client, tenant):
    response = client.get("/api/v1/org/designations", headers=tenant.headers())
    assert response.status_code == 200, response.text
    return response.json()


def test_the_list_reads_from_level_one_down(client, tenants):
    acme, _ = tenants
    for name, level in (("Trainee", 9), ("Director", 1), ("Manager", 3)):
        response = client.post(
            "/api/v1/org/designations", json={"name": name, "level": level}, headers=acme.headers()
        )
        assert response.status_code == 201, response.text

    assert [d["name"] for d in _designations(client, acme)] == ["Director", "Manager", "Trainee"]


def test_level_zero_is_refused(client, tenants):
    acme, _ = tenants
    response = client.post(
        "/api/v1/org/designations", json={"name": "Nobody", "level": 0}, headers=acme.headers()
    )
    assert response.status_code == 422


def test_a_title_can_be_tied_to_a_department_and_edited(client, tenants):
    acme, _ = tenants
    sales = client.post(
        "/api/v1/org/departments", json={"name": "Sales"}, headers=acme.headers()
    ).json()
    created = client.post(
        "/api/v1/org/designations",
        json={"name": "Executive", "level": 7, "department_id": sales["id"]},
        headers=acme.headers(),
    ).json()
    assert created["department_name"] == "Sales"

    response = client.patch(
        f"/api/v1/org/designations/{created['id']}",
        json={"name": "Senior Executive", "level": 6, "department_id": None, "is_active": False},
        headers=acme.headers(),
    )
    assert response.status_code == 200, response.text
    edited = response.json()
    assert (edited["name"], edited["level"], edited["department_id"], edited["is_active"]) == (
        "Senior Executive", 6, None, False,
    )


def test_renaming_onto_an_existing_title_is_refused(client, tenants):
    acme, _ = tenants
    client.post("/api/v1/org/designations", json={"name": "Manager"}, headers=acme.headers())
    other = client.post(
        "/api/v1/org/designations", json={"name": "Team Lead"}, headers=acme.headers()
    ).json()
    response = client.patch(
        f"/api/v1/org/designations/{other['id']}", json={"name": "Manager"}, headers=acme.headers()
    )
    assert response.status_code == 409


def test_another_companys_department_cannot_be_attached(client, tenants):
    acme, globex = tenants
    foreign = client.post(
        "/api/v1/org/departments", json={"name": "Globex Ops"}, headers=globex.headers()
    ).json()
    response = client.post(
        "/api/v1/org/designations",
        json={"name": "Executive", "department_id": foreign["id"]},
        headers=acme.headers(),
    )
    assert response.status_code == 404


def test_another_companys_title_cannot_be_edited(client, tenants):
    acme, globex = tenants
    theirs = client.post(
        "/api/v1/org/designations", json={"name": "Director"}, headers=globex.headers()
    ).json()
    response = client.patch(
        f"/api/v1/org/designations/{theirs['id']}", json={"name": "Hijacked"}, headers=acme.headers()
    )
    assert response.status_code == 404
