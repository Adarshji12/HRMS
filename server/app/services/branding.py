"""The company's own logo, which replaces the product mark in its console.

Three rules hold this file together, and each one is a decision rather than a
detail.

**Nothing is served that we did not encode.** An uploaded logo is decoded with
Pillow, re-drawn, and written back out as a PNG we produced. The bytes that
arrived are never stored and never served. That is what makes this endpoint safe
to point an ``<img>`` at: a file can be a valid PNG *and* carry a payload in a
chunk some other parser will read, and re-encoding drops everything that is not
pixels — EXIF, colour profiles, comments, trailing data, the lot.

**SVG is refused, and that is not an oversight.** It is the format a designer
will reach for first and the one that cannot be made safe here: an SVG is a
document that can carry script and external references, and serving it from the
console's own origin would be a stored cross-site-scripting hole with a company
logo painted on it. Rasterising it instead would need a full SVG renderer.

**A logo is small.** It is drawn at 30px in the sidebar. The stored image is
capped at 512px on its longest side, which is four times what any display of it
needs and leaves room for a future letterhead without keeping a 4000px original
nobody will ever paint.
"""

from __future__ import annotations

import io
import uuid
from datetime import datetime, timezone

from PIL import Image, UnidentifiedImageError
from sqlalchemy.orm import Session

from app.models import Organization
from app.services import storage

#: Two megabytes. A logo that does not fit in two megabytes is a photograph.
MAX_LOGO_BYTES = 2 * 1024 * 1024

#: Longest side of the stored image. See the module docstring.
MAX_LOGO_EDGE = 512

#: What Pillow is allowed to have recognised. The check is on the *decoded*
#: format, not on the filename or the declared content type, both of which are
#: supplied by the caller and neither of which is evidence of anything.
ALLOWED_FORMATS = {"PNG", "JPEG", "WEBP", "GIF", "BMP"}

#: Everything is stored as PNG, whatever arrived. One format out means one
#: content type to serve, transparency survives, and there is no quality
#: setting to get wrong on an image made of flat colour and type.
STORED_CONTENT_TYPE = "image/png"


class BrandingError(Exception):
    """A refusal the console can branch on, in the shape the rest of the API uses."""

    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _normalise(raw: bytes) -> bytes:
    """Decode, downscale, re-encode as PNG. Raises ``BrandingError`` on junk."""
    try:
        image = Image.open(io.BytesIO(raw))
        image.load()
    except UnidentifiedImageError as exc:
        raise BrandingError(
            "unreadable",
            "That file is not an image the console can read. PNG, JPEG or WEBP.",
        ) from exc
    except Exception as exc:  # noqa: BLE001 — any decode failure is the caller's
        raise BrandingError("unreadable", f"That image could not be read: {exc}") from exc

    if image.format not in ALLOWED_FORMATS:
        raise BrandingError(
            "bad_format",
            f"{image.format or 'That format'} is not supported. Use PNG, JPEG or WEBP.",
        )

    # RGBA throughout, so a logo with a transparent background keeps it on both
    # the light and the dark theme. A flattened logo would carry a white box
    # into dark mode, which is the single most visible way to get this wrong.
    if image.mode != "RGBA":
        image = image.convert("RGBA")

    if max(image.size) > MAX_LOGO_EDGE:
        # thumbnail, not resize: it preserves the aspect ratio, and a logo
        # stretched to a square is worse than no logo.
        image.thumbnail((MAX_LOGO_EDGE, MAX_LOGO_EDGE), Image.LANCZOS)

    out = io.BytesIO()
    image.save(out, format="PNG", optimize=True)
    return out.getvalue()


def store_logo(db: Session, org: Organization, raw: bytes) -> Organization:
    """Replace this company's logo. The previous object is deleted."""
    if not raw:
        raise BrandingError("empty_upload", "The file is empty.")
    if len(raw) > MAX_LOGO_BYTES:
        raise BrandingError(
            "too_large",
            f"Logos are limited to {MAX_LOGO_BYTES // (1024 * 1024)} MB.",
            413,
        )

    encoded = _normalise(raw)

    # A fresh key every time rather than one stable per-tenant path. Overwriting
    # in place would leave every proxy and browser between here and the reader
    # holding the old image under a URL whose contents had silently changed.
    key = f"{org.id}/branding/{uuid.uuid4().hex}.png"
    try:
        storage.backend().put(key, encoded, STORED_CONTENT_TYPE)
    except storage.StorageError as exc:
        raise BrandingError("storage_failed", f"The logo could not be stored: {exc}", 500) from exc

    previous = org.logo_key
    org.logo_key = key
    org.logo_updated_at = _now()
    db.flush()

    # After the row points at the new object, never before: a delete that ran
    # first and a flush that then failed would leave the company with no logo
    # and a row insisting it had one.
    if previous and previous != key:
        storage.delete(previous)

    return org


def clear_logo(db: Session, org: Organization) -> Organization:
    """Back to the product mark. Idempotent — clearing nothing is not an error."""
    previous = org.logo_key
    org.logo_key = None
    org.logo_updated_at = None
    db.flush()
    if previous:
        storage.delete(previous)
    return org


def serve_logo(org: Organization) -> storage.Served:
    """Where the bytes are. The permission check belongs to the caller."""
    if not org.logo_key:
        raise BrandingError("no_logo", "This company has not uploaded a logo.", 404)
    try:
        return storage.serve(org.logo_key)
    except FileNotFoundError as exc:
        # The row says there is a logo and storage disagrees. Report it as
        # missing rather than as a server fault: an administrator can fix it by
        # uploading again, which is the only useful thing anyone can do.
        raise BrandingError(
            "logo_missing", "The stored logo could not be found. Upload it again.", 404
        ) from exc
