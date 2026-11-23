"""Ledger master: create, validate, list, edit, delete, and stay inside the tenant."""

from __future__ import annotations

from tests.test_erp import API, acme, globex, ok, refused  # noqa: F401


def _ledger(**extra) -> dict:
    return {"name": "Gupta Medical", "account_group": "Sundry Debtors", "state": "Rajasthan",
            "station": "Chittorgarh Town", "mobile": "+91 98765 43210", **extra}


def test_ledger_is_created_with_a_code_and_a_clean_mobile(client, acme):
    row = ok(client.post(f"{API}/ledgers", json=_ledger(opening_balance="420", opening_type="dr"),
                         headers=acme.headers()), 201)
    assert row["code"].startswith("LED")
    assert row["mobile"] == "9876543210"
    assert row["balance"] == "420.00" and row["balance_type"] == "dr"
    rows = ok(client.get(f"{API}/ledgers", params={"q": "gupta"}, headers=acme.headers()))
    assert [r["id"] for r in rows] == [row["id"]]


def test_ledger_rejects_bad_phone_email_pin_and_gstin(client, acme):
    for bad in ({"mobile": "12345"}, {"email": "shreya"}, {"pincode": "12"}, {"gstin": "NOPE"}, {"pan": "x"}):
        refused(client.post(f"{API}/ledgers", json=_ledger(**bad), headers=acme.headers()), 422)


def test_ledger_names_are_unique_and_editable(client, acme):
    row = ok(client.post(f"{API}/ledgers", json=_ledger(), headers=acme.headers()), 201)
    refused(client.post(f"{API}/ledgers", json=_ledger(name="gupta medical"), headers=acme.headers()),
            409, "duplicate_ledger")
    out = ok(client.put(f"{API}/ledgers/{row['id']}", json=_ledger(city="Chittorgarh"), headers=acme.headers()))
    assert out["city"] == "Chittorgarh" and out["code"] == row["code"]
    assert client.delete(f"{API}/ledgers/{row['id']}", headers=acme.headers()).status_code == 204
    assert ok(client.get(f"{API}/ledgers", headers=acme.headers())) == []


def test_ledgers_are_private_to_their_company(client, acme, globex):
    row = ok(client.post(f"{API}/ledgers", json=_ledger(), headers=acme.headers()), 201)
    assert ok(client.get(f"{API}/ledgers", headers=globex.headers())) == []
    assert client.get(f"{API}/ledgers/{row['id']}", headers=globex.headers()).status_code == 404


def test_account_groups_are_seeded_as_a_tree_and_can_be_added(client, acme):
    rows = ok(client.get(f"{API}/account-groups", headers=acme.headers()))
    names = [r["name"] for r in rows]
    assert names[0] == "Assets" and "Bank Accounts" in names and "Sundry Debtors" in names
    assert next(r for r in rows if r["name"] == "Bank Accounts")["depth"] == 3
    parent = next(r for r in rows if r["name"] == "Indirect Expenses")
    made = ok(client.post(f"{API}/account-groups", json={"name": "Branch Expenses", "parent_id": parent["id"]},
                          headers=acme.headers()), 201)
    refused(client.post(f"{API}/account-groups", json={"name": "branch expenses", "parent_id": parent["id"]},
                        headers=acme.headers()), 409, "duplicate_group")
    # A standard group cannot be deleted; one a person added can.
    refused(client.delete(f"{API}/account-groups/{parent['id']}", headers=acme.headers()), 409)
    assert client.delete(f"{API}/account-groups/{made['id']}", headers=acme.headers()).status_code == 204


def test_account_groups_are_private_to_their_company(client, acme, globex):
    ok(client.get(f"{API}/account-groups", headers=acme.headers()))
    parent = ok(client.get(f"{API}/account-groups", headers=acme.headers()))[0]
    assert client.post(f"{API}/account-groups", json={"name": "X", "parent_id": parent["id"]},
                       headers=globex.headers()).status_code == 404


def test_chart_of_accounts_rolls_balances_up_and_numbers_the_groups(client, acme):
    ok(client.post(f"{API}/ledgers", json=_ledger(opening_balance="420", opening_type="dr"), headers=acme.headers()), 201)
    ok(client.post(f"{API}/ledgers", json=_ledger(name="Paliwal Traders", account_group="Sundry Creditors",
                                                  opening_balance="1000", opening_type="cr"), headers=acme.headers()), 201)
    tree = ok(client.get(f"{API}/accounts", headers=acme.headers()))
    groups = {g["name"]: g for g in tree["groups"]}
    assert groups["Assets"]["code"] == "1000" and groups["Liabilities"]["code"] == "2000"
    assert groups["Current Assets"]["code"].startswith("11")
    assert groups["Sundry Debtors"]["balance"] == "420.00" and groups["Assets"]["balance"] == "420.00"
    assert groups["Liabilities"]["balance"] == "-1000.00"          # credit is negative
    assert {l["name"] for l in tree["ledgers"]} == {"Gupta Medical", "Paliwal Traders"}


def test_group_can_be_renamed_renumbered_and_archived(client, acme):
    rows = ok(client.get(f"{API}/account-groups", headers=acme.headers()))
    parent = next(r for r in rows if r["name"] == "Indirect Expenses")
    made = ok(client.post(f"{API}/account-groups", json={"name": "Branch Expenses", "parent_id": parent["id"]},
                          headers=acme.headers()), 201)
    assert made["code"] and made["code"].startswith("52")
    out = ok(client.patch(f"{API}/account-groups/{made['id']}", json={"name": "Site Expenses", "code": "5290"},
                          headers=acme.headers()))
    assert out["name"] == "Site Expenses" and out["code"] == "5290"
    refused(client.patch(f"{API}/account-groups/{made['id']}", json={"name": "Site Expenses", "code": parent["code"]},
                         headers=acme.headers()), 409, "duplicate_code")
    assert client.post(f"{API}/account-groups/{made['id']}/archive", json={"archived": True},
                       headers=acme.headers()).status_code == 204
    assert "Site Expenses" not in [g["name"] for g in ok(client.get(f"{API}/accounts", headers=acme.headers()))["groups"]]
    refused(client.post(f"{API}/account-groups/{parent['id']}/archive", json={"archived": True},
                        headers=acme.headers()), 409, "system_group")


def test_archiving_a_ledger_hides_it_from_the_chart(client, acme):
    row = ok(client.post(f"{API}/ledgers", json=_ledger(), headers=acme.headers()), 201)
    ok(client.post(f"{API}/ledgers/{row['id']}/archive", json={"archived": True}, headers=acme.headers()))
    assert ok(client.get(f"{API}/accounts", headers=acme.headers()))["ledgers"] == []
    assert len(ok(client.get(f"{API}/accounts", params={"archived": "true"}, headers=acme.headers()))["ledgers"]) == 1
