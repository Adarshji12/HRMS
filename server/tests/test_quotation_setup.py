"""The quotation screen in CRM Settings: what it stores, and what it changes.

Numbering and tax are the parts with consequences — a wrong number is a
duplicate invoice reference, a wrong state is the wrong tax — so most of this
file is about those, not about the form round-tripping.
"""
import io
from datetime import date

import pytest
from PIL import Image


@pytest.fixture
def acme(tenants):
    return tenants[0]


def _settings(client, tenant):
    response = client.get("/api/v1/crm/settings", headers=tenant.headers())
    assert response.status_code == 200, response.text
    return response.json()


def _save_setup(client, tenant, **setup):
    response = client.put(
        "/api/v1/crm/settings", json={"quotation_setup": setup}, headers=tenant.headers()
    )
    assert response.status_code == 200, response.text
    return response.json()


def _quote(client, tenant, **overrides):
    payload = {
        "quote_date": date.today().isoformat(), "customer_name": "Advotalk",
        "lines": [{"name": "Consulting", "quantity": "1", "rate": "1000", "gst_percent": "18"}],
        **overrides,
    }
    response = client.post("/api/v1/crm/quotations", json=payload, headers=tenant.headers())
    assert response.status_code == 201, response.text
    return response.json()


def _png() -> bytes:
    out = io.BytesIO()
    Image.new("RGBA", (40, 20), (10, 60, 120, 255)).save(out, format="PNG")
    return out.getvalue()


def test_defaults_keep_the_old_numbering(client, acme):
    settings = _settings(client, acme)
    assert settings["quotation_setup"]["style"] == "simple"
    assert settings["quotation_setup"]["default_gst"] == "18"
    year = date.today().year
    assert settings["quotation_next_number"] == f"QT-{year}-0001"
    assert _quote(client, acme)["number"] == f"QT-{year}-0001"
    assert _settings(client, acme)["quotation_next_number"] == f"QT-{year}-0002"


def test_a_financial_year_format(client, acme):
    _save_setup(client, acme, number_format="{PREFIX}/{FY}/{SEQ}")
    on = date(2026, 11, 3)
    assert _quote(client, acme, quote_date=on.isoformat())["number"] == "QT/2026-27/0001"
    # March still belongs to the year that started the April before.
    assert _quote(client, acme, quote_date="2027-03-31")["number"] == "QT/2026-27/0002"
    assert _quote(client, acme, quote_date="2027-04-01")["number"] == "QT/2027-28/0001"


def test_a_format_must_carry_the_sequence_and_known_tokens(client, acme):
    for bad in ("{PREFIX}-{FY}", "{PREFIX}-{DAY}-{SEQ}", "{PREFIX}#{SEQ}"):
        response = client.put(
            "/api/v1/crm/settings", json={"quotation_setup": {"number_format": bad}},
            headers=acme.headers(),
        )
        assert response.status_code == 422, bad


def test_the_letterhead_gstin_decides_the_tax_state(client, acme):
    # 27 is Maharashtra. A customer in Karnataka is then inter-state: IGST.
    _save_setup(client, acme, gstin="27AAAAA0000A1Z5")
    quote = _quote(client, acme, state="Karnataka")
    assert quote["is_interstate"] is True and quote["igst"] == "180.00"
    same = _quote(client, acme, state="Maharashtra")
    assert same["is_interstate"] is False and same["cgst"] == "90.00"


def test_details_round_trip_and_bad_values_are_refused(client, acme):
    saved = _save_setup(
        client, acme, style="detailed", company_name="Acme Ltd", bank_enabled=True,
        bank_name="HDFC", account_number="50100123", ifsc="hdfc0001234",
        upi_enabled=True, upi_id="acme@okhdfc", footer="Thank you", signatory="R. Sharma",
        default_gst="12",
    )["quotation_setup"]
    assert saved["style"] == "detailed" and saved["ifsc"] == "HDFC0001234"
    assert saved["upi_id"] == "acme@okhdfc" and saved["default_gst"] == "12"
    for bad in ({"ifsc": "NOTANIFSC"}, {"upi_id": "no-at-sign"}, {"gstin": "1234"},
                {"default_gst": "40"}, {"style": "fancy"}):
        response = client.put(
            "/api/v1/crm/settings", json={"quotation_setup": bad}, headers=acme.headers()
        )
        assert response.status_code == 422, bad


def test_logo_and_stamp_upload_survive_a_save(client, acme):
    for kind in ("logo", "stamp"):
        up = client.post(
            f"/api/v1/crm/settings/quotation-images/{kind}",
            files={"file": (f"{kind}.png", _png(), "image/png")}, headers=acme.headers(),
        )
        assert up.status_code == 204, up.text
    setup = _settings(client, acme)["quotation_setup"]
    assert setup["has_logo"] and setup["has_stamp"]

    # Saving the form, which never sends image keys, must not drop them.
    _save_setup(client, acme, company_name="Acme Ltd")
    assert _settings(client, acme)["quotation_setup"]["has_logo"] is True

    image = client.get("/api/v1/crm/settings/quotation-images/logo", headers=acme.headers())
    assert image.status_code == 200 and image.headers["content-type"] == "image/png"

    gone = client.delete("/api/v1/crm/settings/quotation-images/stamp", headers=acme.headers())
    assert gone.status_code == 204
    assert _settings(client, acme)["quotation_setup"]["has_stamp"] is False

    junk = client.post(
        "/api/v1/crm/settings/quotation-images/logo",
        files={"file": ("x.png", b"not an image", "image/png")}, headers=acme.headers(),
    )
    assert junk.status_code == 422


def test_the_editor_defaults_are_readable_without_admin(client, acme):
    _save_setup(client, acme, gstin="29AAAAA0000A1Z5", default_gst="5")
    staff = acme.headers(acme.employee_token)
    response = client.get("/api/v1/crm/quotation-defaults", headers=staff)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["home_state"] == "karnataka" and body["default_gst"] == "5"
    # ...but the settings themselves stay administrator-only.
    assert client.get("/api/v1/crm/settings", headers=staff).status_code == 403


def test_the_proposal_letterhead_and_letter_round_trip(client, acme):
    saved = _save_setup(
        client, acme, style="detailed", accent_color="#0B3A66", letterhead_align="center",
        tagline="Software that runs your business", cin="u72200mh2020ptc123456",
        pan="aaaca1234b", show_gstin_in_header=False,
        letter_subject="Proposal for {company}", letter_greeting="Dear {customer},",
        letter_body="Thank you for the opportunity.", letter_closing="Warm regards,",
        payment_terms="50% advance", delivery_terms="Two weeks", warranty_terms="One year",
    )["quotation_setup"]
    assert saved["letterhead_align"] == "center" and saved["show_gstin_in_header"] is False
    assert saved["cin"] == "U72200MH2020PTC123456" and saved["pan"] == "AAACA1234B"
    assert saved["letter_greeting"] == "Dear {customer}," and saved["warranty_terms"] == "One year"
    for bad in ({"accent_color": "navy"}, {"letterhead_align": "right"},
                {"pan": "1234"}, {"cin": "SHORT"}):
        response = client.put(
            "/api/v1/crm/settings", json={"quotation_setup": bad}, headers=acme.headers()
        )
        assert response.status_code == 422, bad
