"""Receipt and payment vouchers: they must balance, number themselves, move ledger balances, and cancel cleanly."""

from __future__ import annotations

from tests.test_erp import API, acme, globex, ok, refused  # noqa: F401


def _ledger(client, tenant, name, group, **extra) -> dict:
    return ok(client.post(f"{API}/ledgers", json={"name": name, "account_group": group, **extra},
                          headers=tenant.headers()), 201)


def _receipt(client, tenant, party, cash, amount="420", **extra):
    body = {
        "voucher_date": "2026-11-17",
        "narration": "Receipt from Gupta Medical",
        "lines": [
            {"ledger_id": cash["id"], "entry": "dr", "amount": amount},
            {"ledger_id": party["id"], "entry": "cr", "amount": amount},
        ],
        **extra,
    }
    return client.post(f"{API}/vouchers/receipt", json=body, headers=tenant.headers())


def test_a_receipt_posts_to_both_ledgers_and_moves_their_balances(client, acme):
    party = _ledger(client, acme, "Gupta Medical", "Sundry Debtors", opening_balance="1000", opening_type="dr")
    cash = _ledger(client, acme, "Cash in Hand", "Cash-in-Hand")
    row = ok(_receipt(client, acme, party, cash), 201)
    assert row["number"].startswith("RCP/") and row["number"].endswith("/0001")
    assert row["party"] == "Gupta Medical" and row["credit"] == "420.00" and row["debit"] == "0.00"
    assert [p["ledger"] for p in row["postings"]] == ["Cash in Hand", "Gupta Medical"]
    owed = ok(client.get(f"{API}/vouchers/ledger-balance/{party['id']}", headers=acme.headers()))
    assert owed["balance"] == "580.00" and owed["side"] == "dr"
    held = ok(client.get(f"{API}/vouchers/ledger-balance/{cash['id']}", headers=acme.headers()))
    assert held["balance"] == "420.00" and held["side"] == "dr"


def test_numbers_run_on_and_the_book_lists_newest_first(client, acme):
    party = _ledger(client, acme, "Gupta Medical", "Sundry Debtors")
    cash = _ledger(client, acme, "Cash in Hand", "Cash-in-Hand")
    first = ok(_receipt(client, acme, party, cash), 201)
    second = ok(_receipt(client, acme, party, cash, voucher_date="2026-11-20"), 201)
    assert first["number"].endswith("/0001") and second["number"].endswith("/0002")
    rows = ok(client.get(f"{API}/vouchers/receipt", params={"start": "2026-11-01", "end": "2026-11-30"},
                         headers=acme.headers()))
    assert [r["number"] for r in rows] == [second["number"], first["number"]]
    assert ok(client.get(f"{API}/vouchers/receipt", params={"start": "2026-12-01"}, headers=acme.headers())) == []


def test_an_unbalanced_or_one_sided_voucher_is_refused(client, acme):
    party = _ledger(client, acme, "Gupta Medical", "Sundry Debtors")
    cash = _ledger(client, acme, "Cash in Hand", "Cash-in-Hand")
    bad = {
        "voucher_date": "2026-11-17",
        "lines": [{"ledger_id": cash["id"], "entry": "dr", "amount": "500"},
                  {"ledger_id": party["id"], "entry": "cr", "amount": "420"}],
    }
    refused(client.post(f"{API}/vouchers/receipt", json=bad, headers=acme.headers()), 422, "unbalanced")
    bad["lines"][1] = {"ledger_id": party["id"], "entry": "dr", "amount": "500"}
    refused(client.post(f"{API}/vouchers/receipt", json=bad, headers=acme.headers()), 422, "one_sided")


def test_a_cancelled_voucher_stops_posting_but_stays_in_the_book(client, acme):
    party = _ledger(client, acme, "Gupta Medical", "Sundry Debtors")
    cash = _ledger(client, acme, "Cash in Hand", "Cash-in-Hand")
    row = ok(_receipt(client, acme, party, cash), 201)
    refused(client.post(f"{API}/vouchers/item/{row['id']}/cancel", json={}, headers=acme.headers()), 422)
    done = ok(client.post(f"{API}/vouchers/item/{row['id']}/cancel", json={"reason": "Wrong party"},
                          headers=acme.headers()))
    assert done["status"] == "cancelled"
    held = ok(client.get(f"{API}/vouchers/ledger-balance/{cash['id']}", headers=acme.headers()))
    assert held["balance"] == "0.00"
    assert len(ok(client.get(f"{API}/vouchers/receipt", headers=acme.headers()))) == 1


def test_a_payment_debits_the_party_and_vouchers_are_private_to_their_company(client, acme, globex):
    party = _ledger(client, acme, "Sharma Traders", "Sundry Creditors")
    cash = _ledger(client, acme, "Cash in Hand", "Cash-in-Hand")
    body = {"voucher_date": "2026-11-17", "lines": [
        {"ledger_id": party["id"], "entry": "dr", "amount": "300"},
        {"ledger_id": cash["id"], "entry": "cr", "amount": "300"}]}
    row = ok(client.post(f"{API}/vouchers/payment", json=body, headers=acme.headers()), 201)
    assert row["number"].startswith("PAY/") and row["debit"] == "300.00" and row["credit"] == "0.00"
    assert ok(client.get(f"{API}/vouchers/payment", headers=globex.headers())) == []
    refused(client.get(f"{API}/vouchers/item/{row['id']}", headers=globex.headers()), 404)
