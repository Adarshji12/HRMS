"""Screenshot storage.

Two backends behind one interface: local disk for a single box, S3-compatible
object storage (AWS S3, MinIO, Cloudflare R2, Wasabi) for a fleet. Nothing
outside this module builds a path or knows which backend is in use — callers
only ever hold an opaque ``storage_key``.

Serving differs by necessity and the difference is deliberate:

* **local** streams the bytes through the API, so access control is enforced on
  every request.
* **s3** issues a short-lived presigned URL and redirects. Streaming gigabytes
  of screenshots through the application server to save five minutes of URL
  validity is the wrong trade at fleet scale — but the URL is minted only after
  the same permission check, and expires in minutes.

Layout: ``<org_id>/<user_id>/<YYYY-MM-DD>/<screenshot_id>.jpg``
"""

from __future__ import annotations

import io
import logging
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageFilter

from app.core.config import settings

log = logging.getLogger(__name__)

THUMB_WIDTH = 320


class StorageError(RuntimeError):
    pass


@dataclass(frozen=True)
class Served:
    """How to deliver an object: either a local path or a redirect URL."""

    path: Path | None = None
    url: str | None = None


# --------------------------------------------------------------------------- #
# Backends
# --------------------------------------------------------------------------- #


class LocalBackend:
    name = "local"

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _abs(self, key: str) -> Path:
        target = (self.root / key).resolve()
        # Defence in depth: a crafted key must not escape the storage root.
        if not target.is_relative_to(self.root):
            raise StorageError(f"storage key escapes root: {key!r}")
        return target

    def put(self, key: str, data: bytes, content_type: str = "image/jpeg") -> int:
        path = self._abs(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return len(data)

    def serve(self, key: str) -> Served:
        path = self._abs(key)
        if not path.exists():
            raise FileNotFoundError(key)
        return Served(path=path)

    def read(self, key: str) -> bytes:
        path = self._abs(key)
        if not path.exists():
            raise FileNotFoundError(key)
        return path.read_bytes()

    def delete(self, key: str) -> None:
        try:
            self._abs(key).unlink(missing_ok=True)
        except StorageError:
            pass


class S3Backend:
    name = "s3"

    def __init__(self) -> None:
        try:
            import boto3
            from botocore.config import Config
        except ImportError as exc:  # pragma: no cover
            raise StorageError(
                "STORAGE_BACKEND=s3 requires boto3 — pip install boto3"
            ) from exc

        if not settings.s3_bucket:
            raise StorageError("STORAGE_BACKEND=s3 requires S3_BUCKET")

        self.bucket = settings.s3_bucket
        self._client = boto3.client(
            "s3",
            region_name=settings.s3_region or None,
            endpoint_url=settings.s3_endpoint_url or None,
            aws_access_key_id=settings.s3_access_key_id or None,
            aws_secret_access_key=settings.s3_secret_access_key or None,
            # s3v4 is required by MinIO and by newer AWS regions; without it
            # presigned URLs are rejected with an opaque signature error.
            config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
        )

    def put(self, key: str, data: bytes, content_type: str = "image/jpeg") -> int:
        try:
            self._client.put_object(
                Bucket=self.bucket,
                Key=key,
                Body=data,
                ContentType=content_type,
                # Screenshots are personal data; never let a bucket policy make
                # them public by accident.
                ACL="private",
            )
        except Exception as exc:  # noqa: BLE001 - botocore raises many types
            raise StorageError(f"could not upload {key}: {exc}") from exc
        return len(data)

    def serve(self, key: str) -> Served:
        try:
            url = self._client.generate_presigned_url(
                "get_object",
                Params={"Bucket": self.bucket, "Key": key},
                ExpiresIn=settings.s3_presign_seconds,
            )
        except Exception as exc:  # noqa: BLE001
            raise StorageError(f"could not sign {key}: {exc}") from exc
        return Served(url=url)

    def read(self, key: str) -> bytes:
        try:
            return self._client.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except self._client.exceptions.NoSuchKey as exc:
            # FileNotFoundError, matching LocalBackend, so a caller can tell
            # "the object is gone" from "the backend is unwell" without knowing
            # which backend it is talking to.
            raise FileNotFoundError(key) from exc
        except Exception as exc:  # noqa: BLE001 - botocore raises many types
            raise StorageError(f"could not read {key}: {exc}") from exc

    def delete(self, key: str) -> None:
        try:
            self._client.delete_object(Bucket=self.bucket, Key=key)
        except Exception:  # noqa: BLE001 - a failed delete must not break retention
            log.exception("could not delete %s from S3", key)


_backend = None
_backend_lock = threading.Lock()


def backend():
    """The configured backend, created once.

    Lazy and locked: boto3 client construction is not free, and building one per
    request under load is a measurable cost for no benefit.
    """
    global _backend
    if _backend is None:
        with _backend_lock:
            if _backend is None:
                if settings.storage_backend == "s3":
                    _backend = S3Backend()
                    log.info("screenshot storage: S3 bucket %s", settings.s3_bucket)
                else:
                    _backend = LocalBackend(settings.storage_dir)
                    log.info("screenshot storage: local disk %s", settings.storage_dir)
    return _backend


# --------------------------------------------------------------------------- #
# Keys and image processing
# --------------------------------------------------------------------------- #


def build_key(
    org_id: uuid.UUID, user_id: uuid.UUID, captured_at: datetime, shot_id: uuid.UUID,
    suffix: str = ".jpg",
) -> str:
    day = captured_at.strftime("%Y-%m-%d")
    return f"{org_id}/{user_id}/{day}/{shot_id}{suffix}"


def save_screenshot(
    raw: bytes,
    *,
    org_id: uuid.UUID,
    user_id: uuid.UUID,
    captured_at: datetime,
    shot_id: uuid.UUID,
    max_width: int,
    quality: int,
    blur: bool,
) -> dict:
    """Normalise, optionally blur, write full image + thumbnail.

    Returns the fields the ``Screenshot`` row needs.
    """
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except Exception as exc:  # noqa: BLE001 - any decode failure is a client error
        raise StorageError(f"unreadable image: {exc}") from exc

    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")

    if max_width and img.width > max_width:
        ratio = max_width / img.width
        img = img.resize((max_width, max(1, round(img.height * ratio))), Image.LANCZOS)

    if blur:
        # Enough to obscure text while leaving the layout recognisable — the
        # low-intrusion mode some works councils require.
        img = img.filter(ImageFilter.GaussianBlur(radius=max(2, img.width // 260)))

    key = build_key(org_id, user_id, captured_at, shot_id)
    thumb_key = build_key(org_id, user_id, captured_at, shot_id, suffix="_thumb.jpg")

    full_buf = io.BytesIO()
    img.save(full_buf, format="JPEG", quality=max(20, min(95, quality)), optimize=True)

    thumb = img.copy()
    if thumb.width > THUMB_WIDTH:
        ratio = THUMB_WIDTH / thumb.width
        thumb = thumb.resize((THUMB_WIDTH, max(1, round(thumb.height * ratio))), Image.LANCZOS)
    thumb_buf = io.BytesIO()
    thumb.save(thumb_buf, format="JPEG", quality=70, optimize=True)

    store = backend()
    size = store.put(key, full_buf.getvalue())
    try:
        store.put(thumb_key, thumb_buf.getvalue())
    except StorageError:
        # A missing thumbnail degrades the gallery; a missing original loses
        # evidence. Keep the original and carry on.
        log.warning("thumbnail upload failed for %s", key)
        thumb_key = ""

    return {
        "storage_key": key,
        "thumb_key": thumb_key,
        "width": img.width,
        "height": img.height,
        "file_size": size,
    }


def serve(key: str) -> Served:
    return backend().serve(key)


def read(key: str) -> bytes:
    """The stored bytes.

    Exists so one document can be *copied* into another record — an onboarding
    document promoted into an employee's permanent file. Sharing the storage key
    between the two rows would be cheaper and is wrong: deleting the onboarding
    document deletes the object, and the permanent row would then point at
    nothing. The copy owns its own bytes precisely so the two lifecycles cannot
    interfere.
    """
    return backend().read(key)


def delete(key: str | None) -> None:
    if not key:
        return
    backend().delete(key)


# Kept for callers that predate the backend split.
def open_stream(key: str) -> Path:
    served = backend().serve(key)
    if served.path is None:
        raise StorageError("this backend serves by URL, not by path — use serve()")
    return served.path
