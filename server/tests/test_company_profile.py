"""Company profile and the console logo.

The interesting assertions here are not "does the form save". They are the four
places this feature could quietly become a hole:

* the logo is a file upload served back over HTTP, so it must not be possible to
  store bytes we did not encode, nor to read another company's;
* the profile is editable by an administrator and readable by everyone, and
  those are two different checks;
* an emptied field has to clear the value rather than store ``""``, because
  ``legal_name or name`` is what prints on a payslip;
* a partial update must not blank the fields it does not mention.
"""

from __future__ import annotations

import io

from PIL import Image


def _png(size=(64, 32), colour=(10, 120, 90, 255)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGBA", size, colour).save(buf, format="PNG")
    return buf.getvalue()


# --------------------------------------------------------------------------- #
# Reading and writing the profile
# --------------------------------------------------------------------------- #


def test_profile_is_readable_by_every_employee(client, tenants):
    acme, _ = tenants
    r = client.get("/api/v1/org/company", headers=acme.headers(acme.employee_token))
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "Acme Ltd"
    assert body["has_logo"] is False
    assert body["logo_updated_at"] is None
    # The storage key is internal and must never reach a client.
    assert "logo_key" not in body


def test_employee_cannot_edit_the_profile(client, tenants):
    acme, _ = tenants
    r = client.put(
        "/api/v1/org/company",
        json={"legal_name": "Sneaky Ltd"},
        headers=acme.headers(acme.employee_token),
    )
    assert r.status_code == 403


def test_admin_updates_only_the_fields_sent(client, tenants):
    acme, _ = tenants
    first = client.put(
        "/api/v1/org/company",
        json={"legal_name": "Acme Private Limited", "city": "Bengaluru"},
        headers=acme.headers(),
    )
    assert first.status_code == 200
    assert first.json()["legal_name"] == "Acme Private Limited"
    assert first.json()["city"] == "Bengaluru"

    # A second edit that mentions neither must leave both alone. This is the
    # whole reason the endpoint takes a partial update.
    second = client.put(
        "/api/v1/org/company", json={"gstin": "29ABCDE1234F1Z5"}, headers=acme.headers()
    )
    assert second.status_code == 200
    assert second.json()["legal_name"] == "Acme Private Limited"
    assert second.json()["city"] == "Bengaluru"
    assert second.json()["gstin"] == "29ABCDE1234F1Z5"


def test_emptied_field_clears_rather_than_storing_blank(client, tenants):
    acme, _ = tenants
    client.put(
        "/api/v1/org/company", json={"legal_name": "Acme Private Limited"},
        headers=acme.headers(),
    )
    r = client.put("/api/v1/org/company", json={"legal_name": "   "}, headers=acme.headers())
    assert r.status_code == 200
    # NULL, not "". Letters render `legal_name or name`, and an empty string
    # wins that fallback and prints a blank company on a legal document.
    assert r.json()["legal_name"] is None


def test_country_is_normalised(client, tenants):
    acme, _ = tenants
    r = client.put("/api/v1/org/company", json={"country": "in"}, headers=acme.headers())
    assert r.json()["country"] == "IN"


def test_slug_cannot_be_changed_here(client, tenants):
    """The tenant subdomain is not a field on this form.

    Pydantic ignores unknown keys, so the request succeeds — what matters is
    that the slug is untouched, because changing it would sign the whole company
    out of a hostname that no longer resolves.
    """
    acme, _ = tenants
    r = client.put("/api/v1/org/company", json={"slug": "not-acme"}, headers=acme.headers())
    assert r.status_code == 200
    assert r.json()["slug"] == "acme"


# --------------------------------------------------------------------------- #
# The logo
# --------------------------------------------------------------------------- #


def test_upload_serve_and_clear(client, tenants):
    acme, _ = tenants

    # Nothing uploaded yet: the image endpoint is a 404, not an empty 200.
    assert client.get("/api/v1/org/company/logo", headers=acme.headers()).status_code == 404

    up = client.post(
        "/api/v1/org/company/logo",
        files={"file": ("logo.png", _png(), "image/png")},
        headers=acme.headers(),
    )
    assert up.status_code == 200, up.text
    assert up.json()["has_logo"] is True
    assert up.json()["logo_updated_at"] is not None

    got = client.get("/api/v1/org/company/logo", headers=acme.headers())
    assert got.status_code == 200
    assert got.headers["content-type"].startswith("image/png")
    # Whatever arrived, what is served is a PNG this server encoded.
    assert Image.open(io.BytesIO(got.content)).format == "PNG"

    # An employee may see their own company's logo — the console chrome draws it
    # for everyone, so a check that only admins could read it would white-label
    # the console for administrators alone.
    assert client.get(
        "/api/v1/org/company/logo", headers=acme.headers(acme.employee_token)
    ).status_code == 200

    cleared = client.delete("/api/v1/org/company/logo", headers=acme.headers())
    assert cleared.status_code == 200
    assert cleared.json()["has_logo"] is False
    assert client.get("/api/v1/org/company/logo", headers=acme.headers()).status_code == 404


def test_upload_is_re_encoded_not_stored_verbatim(client, tenants):
    """A JPEG goes in; a PNG comes out.

    This is the check that the uploaded bytes are never the served bytes. It is
    what makes it safe to point an <img> at this endpoint: a file can be a valid
    image and still carry a payload in a chunk some other parser will read, and
    re-encoding drops everything that is not pixels.
    """
    acme, _ = tenants
    buf = io.BytesIO()
    Image.new("RGB", (40, 40), (200, 30, 30)).save(buf, format="JPEG")
    original = buf.getvalue()

    client.post(
        "/api/v1/org/company/logo",
        files={"file": ("logo.jpg", original, "image/jpeg")},
        headers=acme.headers(),
    )
    served = client.get("/api/v1/org/company/logo", headers=acme.headers()).content
    assert served != original
    assert Image.open(io.BytesIO(served)).format == "PNG"


def test_oversized_image_is_downscaled(client, tenants):
    acme, _ = tenants
    client.post(
        "/api/v1/org/company/logo",
        files={"file": ("big.png", _png(size=(2000, 1000)), "image/png")},
        headers=acme.headers(),
    )
    served = client.get("/api/v1/org/company/logo", headers=acme.headers()).content
    image = Image.open(io.BytesIO(served))
    assert max(image.size) <= 512
    # The aspect ratio survives — a logo stretched square is worse than none.
    assert image.width == 2 * image.height


def test_svg_is_refused(client, tenants):
    """Refused deliberately, not by omission — see services/branding.py.

    An SVG is a document that can carry script, and serving one from the
    console's own origin would be stored XSS with a logo painted on it.
    """
    acme, _ = tenants
    svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    r = client.post(
        "/api/v1/org/company/logo",
        files={"file": ("logo.svg", svg, "image/svg+xml")},
        headers=acme.headers(),
    )
    assert r.status_code == 422
    assert r.json()["detail"]["reason"] == "unreadable"


def test_junk_is_refused(client, tenants):
    acme, _ = tenants
    r = client.post(
        "/api/v1/org/company/logo",
        files={"file": ("logo.png", b"this is not an image at all", "image/png")},
        headers=acme.headers(),
    )
    assert r.status_code == 422


def test_employee_cannot_upload_or_clear(client, tenants):
    acme, _ = tenants
    assert client.post(
        "/api/v1/org/company/logo",
        files={"file": ("logo.png", _png(), "image/png")},
        headers=acme.headers(acme.employee_token),
    ).status_code == 403
    assert client.delete(
        "/api/v1/org/company/logo", headers=acme.headers(acme.employee_token)
    ).status_code == 403


def test_one_company_cannot_read_anothers_logo(client, tenants):
    """The endpoint takes no id, which is the point.

    There is no path parameter to tamper with: the caller's own token says which
    company is being asked about, so Globex asking for "the logo" gets Globex's
    — here, none — however Acme's token is presented.
    """
    acme, globex = tenants
    client.post(
        "/api/v1/org/company/logo",
        files={"file": ("logo.png", _png(), "image/png")},
        headers=acme.headers(),
    )
    assert client.get("/api/v1/org/company/logo", headers=globex.headers()).status_code == 404
    assert client.get(
        "/api/v1/org/company", headers=globex.headers()
    ).json()["has_logo"] is False


def test_replacing_a_logo_changes_the_stamp(client, tenants):
    """The stamp is what busts the browser's cache of a one-URL image."""
    acme, _ = tenants
    first = client.post(
        "/api/v1/org/company/logo",
        files={"file": ("a.png", _png(colour=(10, 120, 90, 255)), "image/png")},
        headers=acme.headers(),
    ).json()["logo_updated_at"]
    second = client.post(
        "/api/v1/org/company/logo",
        files={"file": ("b.png", _png(colour=(200, 30, 30, 255)), "image/png")},
        headers=acme.headers(),
    ).json()["logo_updated_at"]
    assert first is not None and second is not None and second != first


def test_tenant_endpoint_carries_the_stamp(client, tenants):
    """`/auth/tenant` is how the console learns to draw the company's mark.

    Public, so this asserts what it exposes: a timestamp, and nothing that would
    let an anonymous caller fetch the image.
    """
    acme, _ = tenants
    before = client.get("/api/v1/auth/tenant", headers={"X-Org-Slug": acme.slug})
    assert before.status_code == 200
    assert before.json()["logo_updated_at"] is None

    client.post(
        "/api/v1/org/company/logo",
        files={"file": ("logo.png", _png(), "image/png")},
        headers=acme.headers(),
    )
    after = client.get("/api/v1/auth/tenant", headers={"X-Org-Slug": acme.slug})
    assert after.json()["logo_updated_at"] is not None

    # The image itself is not public. A bare request is refused at tenancy
    # resolution (400) before it ever reaches the auth check, and one carrying
    # the slug but no token is refused at the auth check. Either way it is not
    # served, which is the claim being made — asserting one exact code here
    # would be asserting the order the two guards happen to run in.
    assert client.get("/api/v1/org/company/logo").status_code != 200
    assert client.get(
        "/api/v1/org/company/logo", headers={"X-Org-Slug": acme.slug}
    ).status_code in (401, 403)
