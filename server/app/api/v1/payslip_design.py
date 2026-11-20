"""Payslip design: layout choice, company block, identifiers, images and what prints."""

from __future__ import annotations

import base64

from fastapi import APIRouter, File, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession, audit
from app.models import PayslipDesign
from app.services import branding, payroll as payroll_svc, payslip_render as render

router = APIRouter(prefix="/payslip-design", tags=["payslip-design"])

IMAGE_KINDS = {"logo": "logo", "signature": "signature", "watermark": "watermark_image"}
TEXT_FIELDS = ("company_name", "cin", "address", "phone", "email", "pan", "tan", "pf_code", "esic_code",
               "lwf_code", "signatory_name", "signatory_designation", "footer_note", "watermark_text")


def _manager(viewer) -> None:
    try:
        payroll_svc._require_manager(viewer)
    except payroll_svc.PayrollError as error:
        raise HTTPException(error.status_code, detail={"reason": error.code, "message": error.message}) from error


def load(db, org_id) -> dict:
    row = db.scalar(select(PayslipDesign).where(PayslipDesign.org_id == org_id))
    return {**render.DEFAULTS, **(row.data if row else {})}


def _public(data: dict) -> dict:
    out = dict(data)
    for k in ("logo", "signature", "watermark_image"):
        out[k] = bool(out.get(k))
    return out


class DesignIn(BaseModel):
    template: str | None = None
    company_name: str | None = Field(default=None, max_length=200)
    cin: str | None = Field(default=None, max_length=40)
    address: str | None = Field(default=None, max_length=400)
    phone: str | None = Field(default=None, max_length=40)
    email: str | None = Field(default=None, max_length=120)
    accent: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    pan: str | None = Field(default=None, max_length=20)
    tan: str | None = Field(default=None, max_length=20)
    pf_code: str | None = Field(default=None, max_length=40)
    esic_code: str | None = Field(default=None, max_length=40)
    lwf_code: str | None = Field(default=None, max_length=40)
    signatory_name: str | None = Field(default=None, max_length=120)
    signatory_designation: str | None = Field(default=None, max_length=120)
    footer_note: str | None = Field(default=None, max_length=300)
    show_bank: bool | None = None
    show_ids: bool | None = None
    show_attendance: bool | None = None
    watermark_on: bool | None = None
    watermark_text: str | None = Field(default=None, max_length=60)
    watermark_strength: int | None = Field(default=None, ge=1, le=50)


@router.get("")
def read(viewer: CurrentUser, db: DbSession) -> dict:
    _manager(viewer)
    return {"settings": _public(load(db, viewer.org_id)),
            "templates": [{"key": k, "name": n, "blurb": b} for k, n, b in render.TEMPLATES]}


@router.put("")
def write(payload: DesignIn, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    _manager(viewer)
    patch = payload.model_dump(exclude_none=True)
    if "template" in patch and patch["template"] not in {t[0] for t in render.TEMPLATES}:
        raise HTTPException(422, "Unknown template")
    row = db.scalar(select(PayslipDesign).where(PayslipDesign.org_id == viewer.org_id))
    if row is None:
        row = PayslipDesign(org_id=viewer.org_id, data={})
        db.add(row)
    row.data = {**(row.data or {}), **patch}
    audit(db, org_id=viewer.org_id, actor=viewer, action="payslip_design.updated", request=request)
    db.commit()
    return {"settings": _public(load(db, viewer.org_id))}


@router.post("/image/{kind}", status_code=204, response_model=None)
async def upload(kind: str, viewer: CurrentUser, db: DbSession, file: UploadFile = File(...)) -> None:
    _manager(viewer)
    if kind not in IMAGE_KINDS:
        raise HTTPException(404, "No such image")
    raw = await file.read(branding.MAX_LOGO_BYTES + 1)
    if not raw or len(raw) > branding.MAX_LOGO_BYTES:
        raise HTTPException(422, "Images must be under 2 MB.")
    try:
        png = branding._normalise(raw)
    except branding.BrandingError as error:
        raise HTTPException(error.status_code, detail={"reason": error.code, "message": error.message}) from error
    row = db.scalar(select(PayslipDesign).where(PayslipDesign.org_id == viewer.org_id))
    if row is None:
        row = PayslipDesign(org_id=viewer.org_id, data={})
        db.add(row)
    row.data = {**(row.data or {}), IMAGE_KINDS[kind]: "data:image/png;base64," + base64.b64encode(png).decode()}
    db.commit()


@router.delete("/image/{kind}", status_code=204, response_model=None)
def remove(kind: str, viewer: CurrentUser, db: DbSession) -> None:
    _manager(viewer)
    if kind not in IMAGE_KINDS:
        raise HTTPException(404, "No such image")
    row = db.scalar(select(PayslipDesign).where(PayslipDesign.org_id == viewer.org_id))
    if row is not None:
        row.data = {k: v for k, v in (row.data or {}).items() if k != IMAGE_KINDS[kind]}
        db.commit()


@router.post("/preview", response_model=None)
def preview(payload: DesignIn, viewer: CurrentUser, db: DbSession) -> Response:
    """The payslip with sample figures, using the draft settings sent (unsaved edits included)."""
    _manager(viewer)
    saved = load(db, viewer.org_id)
    draft = {**saved, **payload.model_dump(exclude_none=True)}
    return Response(render.render(draft, None, payload.template), media_type="text/html; charset=utf-8")


# --------------------------------------------------------------------------- #
# Letterhead (letters only). Kept in the same row, under its own key.
# --------------------------------------------------------------------------- #

from app.services import letterhead_render as lh  # noqa: E402

LH_IMAGES = {"logo": "logo", "signature": "signature", "watermark": "watermark_image"}


def load_letterhead(db, org_id) -> dict:
    row = db.scalar(select(PayslipDesign).where(PayslipDesign.org_id == org_id))
    return {**lh.DEFAULTS, **((row.data or {}).get("letterhead", {}) if row else {})}


def _lh_save(db, org_id, patch: dict) -> None:
    row = db.scalar(select(PayslipDesign).where(PayslipDesign.org_id == org_id))
    if row is None:
        row = PayslipDesign(org_id=org_id, data={})
        db.add(row)
    data = dict(row.data or {})
    data["letterhead"] = {**data.get("letterhead", {}), **patch}
    row.data = data
    db.commit()


class LetterheadIn(BaseModel):
    template: str | None = None
    company_name: str | None = Field(default=None, max_length=200)
    gstin: str | None = Field(default=None, max_length=40)
    address: str | None = Field(default=None, max_length=400)
    phone: str | None = Field(default=None, max_length=40)
    email: str | None = Field(default=None, max_length=120)
    accent: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    show_logo: bool | None = None
    logo_pos: str | None = Field(default=None, pattern="^(left|centre|right)$")
    show_details: bool | None = None
    details_pos: str | None = Field(default=None, pattern="^(left|centre|right)$")
    signatory_name: str | None = Field(default=None, max_length=120)
    signatory_designation: str | None = Field(default=None, max_length=120)
    show_signature: bool | None = None
    signature_pos: str | None = Field(default=None, pattern="^(left|right)$")
    show_footer: bool | None = None
    footer_note: str | None = Field(default=None, max_length=300)
    border_on: bool | None = None
    border_colour: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    border_thickness: str | None = Field(default=None, pattern="^(hairline|thin|medium|thick)$")
    border_margin: str | None = Field(default=None, pattern="^(tight|normal|wide)$")
    watermark_on: bool | None = None
    watermark_text: str | None = Field(default=None, max_length=60)
    watermark_strength: int | None = Field(default=None, ge=1, le=50)


@router.get("/letterhead")
def read_letterhead(viewer: CurrentUser, db: DbSession) -> dict:
    _manager(viewer)
    return {"settings": _public(load_letterhead(db, viewer.org_id)),
            "templates": [{"key": k, "name": n, "blurb": b} for k, n, b in lh.TEMPLATES]}


@router.put("/letterhead")
def write_letterhead(payload: LetterheadIn, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    _manager(viewer)
    patch = payload.model_dump(exclude_none=True)
    if "template" in patch and patch["template"] not in {t[0] for t in lh.TEMPLATES}:
        raise HTTPException(422, "Unknown template")
    _lh_save(db, viewer.org_id, patch)
    audit(db, org_id=viewer.org_id, actor=viewer, action="letterhead.updated", request=request)
    db.commit()
    return {"settings": _public(load_letterhead(db, viewer.org_id))}


@router.post("/letterhead/image/{kind}", status_code=204, response_model=None)
async def upload_letterhead_image(kind: str, viewer: CurrentUser, db: DbSession, file: UploadFile = File(...)) -> None:
    _manager(viewer)
    if kind not in LH_IMAGES:
        raise HTTPException(404, "No such image")
    raw = await file.read(branding.MAX_LOGO_BYTES + 1)
    if not raw or len(raw) > branding.MAX_LOGO_BYTES:
        raise HTTPException(422, "Images must be under 2 MB.")
    try:
        png = branding._normalise(raw)
    except branding.BrandingError as error:
        raise HTTPException(error.status_code, detail={"reason": error.code, "message": error.message}) from error
    _lh_save(db, viewer.org_id, {LH_IMAGES[kind]: "data:image/png;base64," + base64.b64encode(png).decode()})


@router.delete("/letterhead/image/{kind}", status_code=204, response_model=None)
def remove_letterhead_image(kind: str, viewer: CurrentUser, db: DbSession) -> None:
    _manager(viewer)
    if kind not in LH_IMAGES:
        raise HTTPException(404, "No such image")
    _lh_save(db, viewer.org_id, {LH_IMAGES[kind]: None})


@router.post("/letterhead/preview", response_model=None)
def preview_letterhead(payload: LetterheadIn, viewer: CurrentUser, db: DbSession) -> Response:
    _manager(viewer)
    draft = {**load_letterhead(db, viewer.org_id), **payload.model_dump(exclude_none=True)}
    return Response(lh.render(draft, None, payload.template), media_type="text/html; charset=utf-8")
