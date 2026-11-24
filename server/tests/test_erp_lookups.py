"""Inventory lookups: units, HSN / SAC, sub categories, racks, bill series."""

from __future__ import annotations

from tests.test_erp import API, acme, globex, ok, refused  # noqa: F401


def test_units_start_with_the_standard_twelve(client, acme):
    rows = ok(client.get(f"{API}/lookups/unit", headers=acme.headers()))
    assert [r["name"] for r in rows] == ["BAG", "BOX", "DOZ", "GMS", "HRS", "KGS", "LTR", "MTR", "NOS", "PAC", "PCS", "SET"]
    kgs = next(r for r in rows if r["name"] == "KGS")
    assert kgs["description"] == "Kilograms" and kgs["data"] == {"uqc": "KGS", "decimals": 3} and kgs["items"] == 0


def test_a_first_save_still_gets_the_starter_units(client, acme):
    ok(client.post(f"{API}/lookups/unit", json={"name": "strip", "description": "Strip"}, headers=acme.headers()), 201)
    assert {"PCS", "KGS", "STRIP"} <= {r["name"] for r in ok(client.get(f"{API}/lookups/unit", headers=acme.headers()))}


def test_unit_is_created_renamed_counted_and_protected_when_an_item_uses_it(client, acme):
    row = ok(client.post(f"{API}/lookups/unit", json={"name": "strip", "description": "Strip", "data": {"uqc": "OTH", "decimals": 0}},
                         headers=acme.headers()), 201)
    assert row["name"] == "STRIP"
    ok(client.post(f"{API}/items", json={"code": "A-1", "name": "Chips", "uom": "STRIP"}, headers=acme.headers()), 201)
    assert next(r for r in ok(client.get(f"{API}/lookups/unit", headers=acme.headers())) if r["name"] == "STRIP")["items"] == 1
    refused(client.delete(f"{API}/lookups/unit/{row['id']}", headers=acme.headers()), 409, "in_use")
    ok(client.put(f"{API}/lookups/unit/{row['id']}", json={"name": "STRP", "description": "Strip", "data": {"uqc": "OTH", "decimals": 0}}, headers=acme.headers()))
    assert ok(client.get(f"{API}/items", headers=acme.headers()))[0]["uom"] == "STRP"
    refused(client.post(f"{API}/lookups/unit", json={"name": "pcs", "description": "Again"}, headers=acme.headers()), 409, "duplicate")
    refused(client.post(f"{API}/lookups/unit", json={"name": "ABC"}, headers=acme.headers()), 422, "unit_name_needed")
    refused(client.post(f"{API}/lookups/unit", json={"name": "ABC", "description": "Abc", "data": {"uqc": "ZZZ"}}, headers=acme.headers()), 422, "bad_uqc")
    refused(client.post(f"{API}/lookups/unit", json={"name": "ABC", "description": "Abc", "data": {"decimals": 9}}, headers=acme.headers()), 422, "bad_decimals")


def test_hsn_code_and_gst_are_checked(client, acme):
    row = ok(client.post(f"{API}/lookups/hsn", json={"name": "1001", "description": "Wheat", "data": {"gst": 5, "uqc": "KGS", "short_name": "Wheat"}},
                         headers=acme.headers()), 201)
    assert row["data"] == {"gst": 5.0, "type": "hsn", "uqc": "KGS", "short_name": "Wheat"}
    refused(client.post(f"{API}/lookups/hsn", json={"name": "ABC"}, headers=acme.headers()), 422, "bad_hsn")
    refused(client.post(f"{API}/lookups/hsn", json={"name": "1002", "data": {"gst": 50, "uqc": "KGS"}}, headers=acme.headers()), 422, "bad_gst")
    refused(client.post(f"{API}/lookups/hsn", json={"name": "1003", "data": {"gst": 5}}, headers=acme.headers()), 422, "uqc_needed")
    refused(client.post(f"{API}/lookups/hsn", json={"name": "1004", "data": {"gst": 5, "uqc": "ZZZ"}}, headers=acme.headers()), 422, "bad_uqc")


def test_sac_codes_start_with_99_and_report_na(client, acme):
    row = ok(client.post(f"{API}/lookups/hsn", json={"name": "9983", "description": "IT services", "data": {"gst": 18}}, headers=acme.headers()), 201)
    assert row["data"]["type"] == "sac" and row["data"]["uqc"] == "NA"
    refused(client.post(f"{API}/lookups/hsn", json={"name": "9984", "data": {"gst": 18, "type": "hsn", "uqc": "KGS"}}, headers=acme.headers()), 422, "bad_hsn_type")
    refused(client.post(f"{API}/lookups/hsn", json={"name": "3004", "data": {"gst": 12, "type": "sac"}}, headers=acme.headers()), 422, "bad_hsn_type")


def test_sub_category_rack_and_series_need_their_details(client, acme):
    refused(client.post(f"{API}/lookups/subcategory", json={"name": "Salted"}, headers=acme.headers()), 422, "parent_needed")
    ok(client.post(f"{API}/lookups/subcategory", json={"name": "Salted", "parent_name": "Snacks"}, headers=acme.headers()), 201)
    ok(client.post(f"{API}/lookups/rack", json={"name": "R1", "parent_name": "Main store"}, headers=acme.headers()), 201)
    refused(client.post(f"{API}/lookups/billseries", json={"name": "INV", "data": {"type": "nope"}}, headers=acme.headers()), 422, "bad_series")
    row = ok(client.post(f"{API}/lookups/billseries", json={"name": "INV", "data": {"type": "sale", "prefix": "INV/", "next": 5}},
                         headers=acme.headers()), 201)
    assert row["data"]["next"] == 5
    refused(client.get(f"{API}/lookups/nothing", headers=acme.headers()), 404, "bad_kind")


def test_lookups_filter_and_stay_in_their_company(client, acme, globex):
    row = ok(client.post(f"{API}/lookups/rack", json={"name": "R9", "parent_name": "X", "is_active": False}, headers=acme.headers()), 201)
    assert ok(client.get(f"{API}/lookups/rack", params={"active": "true"}, headers=acme.headers())) == []
    assert ok(client.get(f"{API}/lookups/rack", headers=globex.headers())) == []
    assert client.put(f"{API}/lookups/rack/{row['id']}", json={"name": "R9", "parent_name": "X"}, headers=globex.headers()).status_code == 404
    assert client.delete(f"{API}/lookups/rack/{row['id']}", headers=acme.headers()).status_code == 204
