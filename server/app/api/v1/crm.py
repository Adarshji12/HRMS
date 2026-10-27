"""CRM HTTP surface: leads, follow-ups, customers, visits, quotations, reminders.

Thin by design — every handler resolves permission and hands off to
``app.services.crm``. Three things about the shape of this file:

**Scope, not role, is the gate on the day-to-day pages.** A salesperson may open
Leads, Follow-ups, Visits, Customers, the Support Center and Quotations; what
they *see* through them is decided by ``services.crm.visible_owner_ids``, which
resolves to themselves, their team, or the whole company. So there is no
``AdminUser`` on the working endpoints, and there must not be: the module is
called "My Leads" for a reason.

**Configuration is a different question and gets a different gate.** Everything
under ``/crm/masters`` and ``/crm/settings``, plus the reminder writes, is
administrator-only through ``require_admin_crm``. Editing the pipeline's stages
is not sales work.

**One endpoint here is public: the intake webhook.** It authenticates on a
token in the URL and nothing else, has no ``CurrentUser``, and is deliberately
forgiving — it is called by Meta and by whatever form a customer's marketing
agency built, and a 422 back to those means a lost enquiry rather than a fixed
integration. It is declared last, and its own section says so again.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta

from fastapi import APIRouter, File, HTTPException, Query, Request, Response, UploadFile, status
from fastapi.responses import FileResponse, RedirectResponse

from app.api.deps import CurrentUser, DbSession, audit
from app.api.tenancy import CurrentTenant
from app.schemas import crm as S
from app.services import crm as svc
from app.services import crm_geography

router = APIRouter(prefix="/crm", tags=["crm"])


# --------------------------------------------------------------------------- #
# Masters
#
# One set of routes over ten lists, keyed by a path segment. Ten copy-pasted
# CRUD blocks is ten places for a missing org filter to hide, and the console
# renders them through one table component anyway.
# --------------------------------------------------------------------------- #

#: Which schema validates a write to each list, and which one serialises a read.
MASTER_SCHEMAS: dict[str, tuple[type, type]] = {
    "statuses": (S.LeadStatusIn, S.LeadStatusOut),
    "sources": (S.LeadSourceIn, S.LeadSourceOut),
    "industries": (S.NamedIn, S.MasterOut),
    "countries": (S.CountryIn, S.CountryOut),
    "states": (S.StateIn, S.StateOut),
    "districts": (S.DistrictIn, S.DistrictOut),
    "cities": (S.CityIn, S.CityOut),
    "products": (S.ProductIn, S.ProductOut),
    "plans": (S.PlanIn, S.PlanOut),
    "dispositions": (S.DispositionIn, S.DispositionOut),
    "visit-types": (S.VisitTypeIn, S.VisitTypeOut),
    "territories": (S.TerritoryIn, S.TerritoryOut),
    "campaigns": (S.CampaignIn, S.CampaignOut),
    "competitors": (S.CompetitorIn, S.CompetitorOut),
    "contact-designations": (S.ContactDesignationIn, S.ContactDesignationOut),
    "lost-reasons": (S.LostReasonIn, S.LostReasonOut),
    "opportunity-stages": (S.OpportunityStageIn, S.OpportunityStageOut),
}


def _master_schemas(kind: str) -> tuple[type, type]:
    if kind not in MASTER_SCHEMAS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown master list")
    return MASTER_SCHEMAS[kind]


def _parse(in_model: type, payload: dict):
    """Validate a master write, answering 422 the way a typed body would.

    These routes take a plain ``dict`` because the schema depends on the path,
    so FastAPI cannot validate the body itself; a raw ``ValidationError`` here
    would surface as a 500.
    """
    from fastapi.exceptions import RequestValidationError
    from pydantic import ValidationError

    try:
        return in_model(**payload)
    except ValidationError as exc:
        raise RequestValidationError(exc.errors(include_url=False)) from None


def _serialise_master(kind: str, row, db, org_id) -> dict:
    """Read a master row into its output shape, with the derived counts.

    The counts are what make a refusal explainable ("42 leads are in this
    stage") instead of a bare 409, and what lets the settings screen show which
    entries are actually in use.
    """
    from sqlalchemy import func, select

    from app.models import CrmLead, CrmPlan

    _, out_model = _master_schemas(kind)
    data = {
        column.name: getattr(row, column.name)
        for column in row.__table__.columns
        if column.name in out_model.model_fields
    }
    if kind == "statuses":
        data["lead_count"] = db.scalar(
            select(func.count()).select_from(CrmLead).where(
                CrmLead.org_id == org_id, CrmLead.status_id == row.id
            )
        ) or 0
    if kind == "products":
        data["plan_count"] = db.scalar(
            select(func.count()).select_from(CrmPlan).where(CrmPlan.product_id == row.id)
        ) or 0
    if kind == "states":
        data["country_name"] = row.country.name if row.country else None
    if kind == "cities":
        data["state_name"] = row.state.name if row.state else None
        data["country_id"] = row.state.country_id if row.state else None
        data["district_name"] = row.district.name if row.district else None
    if kind == "districts":
        data["state_name"] = row.state.name if row.state else None
    if kind == "plans":
        data["product_name"] = row.product.name if row.product else None
    if kind == "territories":
        from app.models import CrmState

        ids = [uuid.UUID(str(value)) for value in (row.state_ids or [])]
        names = dict(db.execute(
            select(CrmState.id, CrmState.name).where(CrmState.id.in_(ids))
        ).all()) if ids else {}
        data["state_ids"] = [str(value) for value in ids]
        data["state_names"] = [names[value] for value in ids if value in names]
        data["manager_name"] = row.manager.full_name if row.manager else None
    if kind == "campaigns":
        data["source_name"] = row.source.name if row.source else None
    return out_model(**data).model_dump()


@router.get("/masters/{kind}")
def list_master(
    kind: str,
    viewer: CurrentUser,
    db: DbSession,
    parent_id: uuid.UUID | None = Query(default=None),
    include_inactive: bool = True,
) -> list[dict]:
    """One master list.

    Readable by everybody, unlike the writes: a salesperson filling in a lead
    needs the source list, and hiding it behind the administrator gate would
    leave them with empty dropdowns on a form they are required to complete.

    ``parent_id`` narrows states to a country, cities to a state and plans to a
    product — the three lists that are only meaningful under a parent.
    """
    from sqlalchemy import select

    svc.ensure_defaults(db, viewer.org_id)
    model = svc.master_model(kind)
    stmt = select(model).where(model.org_id == viewer.org_id)
    if parent_id is not None:
        parent_column = {
            "states": "country_id", "districts": "state_id", "cities": "state_id",
            "plans": "product_id",
        }.get(kind)
        if parent_column is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "That list has no parent to filter on")
        stmt = stmt.where(getattr(model, parent_column) == parent_id)
    if not include_inactive:
        stmt = stmt.where(model.is_active.is_(True))

    order = model.sort_order if hasattr(model, "sort_order") else model.name
    rows = db.scalars(stmt.order_by(order, model.name)).all()
    return [_serialise_master(kind, row, db, viewer.org_id) for row in rows]


@router.post("/masters/{kind}", status_code=status.HTTP_201_CREATED)
def create_master(kind: str, payload: dict, viewer: CurrentUser, db: DbSession) -> dict:
    svc.require_admin_crm(viewer)
    in_model, _ = _master_schemas(kind)
    data = _parse(in_model, payload)
    model = svc.master_model(kind)
    values = svc.prepare_master(db, viewer.org_id, kind, data.model_dump(), None)
    row = model(org_id=viewer.org_id, **values)
    db.add(row)
    try:
        db.commit()
    except Exception:
        # The unique constraint per (org, name) is what stops two "Website"
        # sources, which is a filter that silently splits in two.
        db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"reason": "duplicate", "message": f"“{data.name}” is already on this list."},
        ) from None
    db.refresh(row)
    return _serialise_master(kind, row, db, viewer.org_id)


@router.put("/masters/{kind}/{row_id}")
def update_master(
    kind: str, row_id: uuid.UUID, payload: dict, viewer: CurrentUser, db: DbSession
) -> dict:
    svc.require_admin_crm(viewer)
    in_model, _ = _master_schemas(kind)
    data = _parse(in_model, payload)
    row = svc.get_master(db, viewer.org_id, kind, row_id)
    values = svc.prepare_master(db, viewer.org_id, kind, data.model_dump(), row_id)
    for field, value in values.items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return _serialise_master(kind, row, db, viewer.org_id)


@router.delete("/masters/{kind}/{row_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_master(kind: str, row_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> None:
    svc.require_admin_crm(viewer)
    svc.delete_master(db, viewer.org_id, kind, row_id)


# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #


@router.get("/settings", response_model=S.CrmSettingsOut)
def read_settings(viewer: CurrentUser, db: DbSession, request: Request) -> S.CrmSettingsOut:
    svc.require_admin_crm(viewer)
    row = svc.get_settings(db, viewer.org_id)
    db.commit()
    return S.CrmSettingsOut(
        assignment_rule=row.assignment_rule,
        default_owner_id=row.default_owner_id,
        assignment_pool=[uuid.UUID(str(x)) for x in (row.assignment_pool or [])],
        intake_enabled=row.intake_enabled,
        # Assembled here rather than stored: the host is a deployment fact, not
        # a tenant one, and a stored URL would be wrong the day the API moves.
        intake_url=(
            f"{str(request.base_url).rstrip('/')}/api/v1/crm/intake/{row.intake_token}"
            if row.intake_token and row.intake_enabled else None
        ),
        quotation_prefix=row.quotation_prefix,
        quotation_terms=row.quotation_terms,
        quotation_validity_days=row.quotation_validity_days,
        quotation_setup=S.QuotationSetupOut(
            **svc.quotation_setup(row).model_dump(),
            has_logo=bool((row.quotation_setup or {}).get("logo_key")),
            has_stamp=bool((row.quotation_setup or {}).get("stamp_key")),
            images_version=(row.quotation_setup or {}).get("images_version"),
        ),
        quotation_next_number=svc.next_quotation_number(db, viewer.org_id, date.today(), peek=True),
        visit_prefix=row.visit_prefix,
        ticket_prefix=row.ticket_prefix,
        renewal_window_days=row.renewal_window_days,
        reminders_enabled=row.reminders_enabled,
    )


@router.put("/settings", response_model=S.CrmSettingsOut)
def write_settings(
    payload: S.CrmSettingsIn, viewer: CurrentUser, db: DbSession, request: Request
) -> S.CrmSettingsOut:
    svc.require_admin_crm(viewer)
    row = svc.get_settings(db, viewer.org_id)
    changes = payload.model_dump(exclude_unset=True)
    if "assignment_pool" in changes and changes["assignment_pool"] is not None:
        changes["assignment_pool"] = [str(x) for x in changes["assignment_pool"]]
    if "quotation_setup" in changes:
        # The screen sends the whole document; the image keys it never sees
        # are carried over rather than wiped.
        incoming = changes.pop("quotation_setup")
        if incoming is not None:
            kept = {
                key: value for key, value in (row.quotation_setup or {}).items()
                if key in ("logo_key", "stamp_key", "images_version")
            }
            setup = S.QuotationSetup.model_validate(incoming).model_dump(mode="json")
            row.quotation_setup = {**setup, **kept}
    for field, value in changes.items():
        setattr(row, field, value)
    # A token is minted the first time capture is switched on and then left
    # alone: regenerating it on every save would break every integration
    # somebody had already pasted the URL into.
    if row.intake_enabled and not row.intake_token:
        import secrets

        row.intake_token = secrets.token_urlsafe(24)
    db.commit()
    return read_settings(viewer, db, request)


@router.get("/quotation-defaults", response_model=S.QuotationDefaults)
def quotation_defaults(viewer: CurrentUser, db: DbSession) -> S.QuotationDefaults:
    """What the quotation editor needs from settings. Any CRM user may read it."""
    defaults = svc.quotation_defaults(db, viewer)
    db.commit()
    return defaults


@router.post("/settings/quotation-images/{kind}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
async def upload_quotation_image(
    kind: str, viewer: CurrentUser, db: DbSession, request: Request, file: UploadFile = File(...)
) -> None:
    """The quotation letterhead's logo, or the company stamp printed over the
    signature line. Re-encoded exactly like the company logo."""
    from app.services import branding

    svc.require_admin_crm(viewer)
    if kind not in svc.QUOTATION_IMAGES:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such image")
    raw = await file.read(branding.MAX_LOGO_BYTES + 1)
    try:
        svc.store_quotation_image(db, viewer, kind, raw)
    except branding.BrandingError as error:
        raise HTTPException(
            error.status_code, detail={"reason": error.code, "message": error.message}
        ) from error
    audit(db, org_id=viewer.org_id, actor=viewer, action=f"crm.quotation_{kind}_updated", request=request)
    db.commit()


@router.delete("/settings/quotation-images/{kind}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_quotation_image(kind: str, viewer: CurrentUser, db: DbSession, request: Request) -> None:
    svc.require_admin_crm(viewer)
    if kind not in svc.QUOTATION_IMAGES:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such image")
    svc.clear_quotation_image(db, viewer, kind)
    audit(db, org_id=viewer.org_id, actor=viewer, action=f"crm.quotation_{kind}_cleared", request=request)
    db.commit()


@router.get("/settings/quotation-images/{kind}")
def quotation_image(kind: str, viewer: CurrentUser, db: DbSession) -> Response:
    """The image itself. Any CRM user may see it: it prints on their documents."""
    from app.services import storage

    if kind not in svc.QUOTATION_IMAGES:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such image")
    key = svc.quotation_image_key(db, viewer.org_id, kind)
    if not key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No image uploaded")
    try:
        served = storage.serve(key)
    except FileNotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "The stored image could not be found. Upload it again.")
    if served.url:
        return RedirectResponse(served.url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)
    return FileResponse(served.path, media_type="image/png",
                        headers={"Cache-Control": "private, max-age=300"})


@router.post("/geography/india")
def load_india_geography(viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    """Add India's 36 states and union territories, their districts and cities.

    Only what is missing is added, so it is safe to press twice; renamed or
    deactivated rows a company already has are left as they are.
    """
    svc.require_admin_crm(viewer)
    added = crm_geography.load_india(db, viewer.org_id)
    audit(db, org_id=viewer.org_id, actor=viewer, action="crm.geography_loaded", request=request,
          detail=added)
    db.commit()
    return added


@router.post("/settings/intake-token", response_model=S.CrmSettingsOut)
def rotate_intake_token(
    viewer: CurrentUser, db: DbSession, request: Request
) -> S.CrmSettingsOut:
    """Mint a new capture URL and invalidate the old one immediately.

    Separate from the settings write on purpose: rotating is a deliberate act
    with a consequence — every integration using the old URL stops working — and
    it should never be something that happens because somebody saved a form.
    """
    import secrets

    svc.require_admin_crm(viewer)
    row = svc.get_settings(db, viewer.org_id)
    row.intake_token = secrets.token_urlsafe(24)
    row.intake_enabled = True
    db.commit()
    return read_settings(viewer, db, request)


# --------------------------------------------------------------------------- #
# Dashboard
# --------------------------------------------------------------------------- #


@router.get("/dashboard", response_model=S.LeadDashboardOut)
def lead_dashboard(
    viewer: CurrentUser,
    db: DbSession,
    date_from: date | None = None,
    date_to: date | None = None,
    owner_id: uuid.UUID | None = None,
    source_id: uuid.UUID | None = None,
    status_id: uuid.UUID | None = None,
) -> S.LeadDashboardOut:
    """Last thirty days by default — what the page opens on."""
    svc.ensure_defaults(db, viewer.org_id)
    to = date_to or date.today()
    frm = date_from or (to - timedelta(days=29))
    return svc.dashboard(
        db, viewer, date_from=frm, date_to=to,
        owner_id=owner_id, source_id=source_id, status_id=status_id,
    )


# --------------------------------------------------------------------------- #
# Leads
#
# The literal sub-paths (/leads/import, /leads/export, /leads/assign) are
# declared BEFORE /leads/{lead_id}. FastAPI matches in declaration order, so a
# literal registered after a UUID parameter is unreachable — "import" would be
# parsed as a lead id and 422 before the handler was considered.
# --------------------------------------------------------------------------- #


@router.get("/leads", response_model=S.LeadPage)
def list_leads(
    viewer: CurrentUser,
    db: DbSession,
    q: str | None = None,
    status_id: uuid.UUID | None = None,
    source_id: uuid.UUID | None = None,
    owner_id: uuid.UUID | None = None,
    product_id: uuid.UUID | None = None,
    industry_id: uuid.UUID | None = None,
    state_id: uuid.UUID | None = None,
    district_id: uuid.UUID | None = None,
    city_id: uuid.UUID | None = None,
    behaviour: str | None = None,
    follow_up: str | None = Query(default=None, pattern=r"^(today|overdue|upcoming|none)$"),
    date_from: date | None = None,
    date_to: date | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=200),
) -> S.LeadPage:
    svc.ensure_defaults(db, viewer.org_id)
    return svc.list_leads(
        db, viewer, q=q, status_id=status_id, source_id=source_id, owner_id=owner_id,
        product_id=product_id, industry_id=industry_id, state_id=state_id,
        district_id=district_id, city_id=city_id, behaviour=behaviour, follow_up=follow_up,
        date_from=date_from, date_to=date_to, page=page, page_size=page_size,
    )


@router.post("/leads", response_model=S.LeadOut, status_code=status.HTTP_201_CREATED)
def create_lead(
    payload: S.LeadIn, viewer: CurrentUser, db: DbSession, request: Request
) -> S.LeadOut:
    return svc.create_lead(db, viewer, payload, request=request)


@router.post("/leads/import", response_model=S.LeadImportResult)
def import_leads(
    payload: S.LeadImportIn, viewer: CurrentUser, db: DbSession, request: Request
) -> S.LeadImportResult:
    return svc.import_leads(db, viewer, payload, request=request)


@router.get("/leads/export")
def export_leads(
    viewer: CurrentUser,
    db: DbSession,
    q: str | None = None,
    status_id: uuid.UUID | None = None,
    source_id: uuid.UUID | None = None,
    owner_id: uuid.UUID | None = None,
    product_id: uuid.UUID | None = None,
    industry_id: uuid.UUID | None = None,
    state_id: uuid.UUID | None = None,
    district_id: uuid.UUID | None = None,
    city_id: uuid.UUID | None = None,
    behaviour: str | None = None,
    follow_up: str | None = Query(default=None, pattern=r"^(today|overdue|upcoming|none)$"),
    date_from: date | None = None,
    date_to: date | None = None,
) -> Response:
    """The current view as CSV — same scope, same filters, no more rows."""
    csv_text = svc.export_leads_csv(
        db, viewer, q=q, status_id=status_id, source_id=source_id, owner_id=owner_id,
        product_id=product_id, industry_id=industry_id, state_id=state_id,
        district_id=district_id, city_id=city_id, behaviour=behaviour,
        follow_up=follow_up, date_from=date_from, date_to=date_to,
    )
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="leads-{date.today()}.csv"'},
    )


@router.post("/leads/assign")
def assign_leads(
    payload: S.LeadBulkAssign, viewer: CurrentUser, db: DbSession, request: Request
) -> dict:
    return {"moved": svc.bulk_assign(db, viewer, payload, request=request)}


@router.get("/leads/{lead_id}", response_model=S.LeadDetailOut)
def lead_detail(lead_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> S.LeadDetailOut:
    return svc.lead_detail(db, viewer, lead_id)


@router.patch("/leads/{lead_id}", response_model=S.LeadOut)
def update_lead(
    lead_id: uuid.UUID, payload: S.LeadPatch, viewer: CurrentUser, db: DbSession, request: Request
) -> S.LeadOut:
    return svc.update_lead(db, viewer, lead_id, payload, request=request)


@router.post("/leads/{lead_id}/status", response_model=S.LeadOut)
def move_lead_status(
    lead_id: uuid.UUID,
    payload: S.LeadStatusMove,
    viewer: CurrentUser,
    db: DbSession,
    request: Request,
) -> S.LeadOut:
    return svc.move_status(db, viewer, lead_id, payload, request=request)


@router.post("/leads/{lead_id}/activities", response_model=S.ActivityOut,
             status_code=status.HTTP_201_CREATED)
def add_activity(
    lead_id: uuid.UUID, payload: S.ActivityIn, viewer: CurrentUser, db: DbSession
) -> S.ActivityOut:
    return svc.add_activity(db, viewer, lead_id, payload)


@router.post("/leads/{lead_id}/convert", response_model=S.CustomerOut,
             status_code=status.HTTP_201_CREATED)
def convert_lead(
    lead_id: uuid.UUID,
    payload: S.ConvertLeadIn,
    viewer: CurrentUser,
    db: DbSession,
    request: Request,
) -> S.CustomerOut:
    return svc.convert_lead(db, viewer, lead_id, payload, request=request)


@router.delete("/leads/{lead_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_lead(
    lead_id: uuid.UUID, viewer: CurrentUser, db: DbSession, request: Request
) -> None:
    svc.delete_lead(db, viewer, lead_id, request=request)


# --------------------------------------------------------------------------- #
# Follow-ups
# --------------------------------------------------------------------------- #


_FOLLOW_UP_STATUS = r"^(pending|done|cancelled|all)$"


@router.get("/follow-ups/export")
def export_follow_ups(
    viewer: CurrentUser,
    db: DbSession,
    status_filter: str | None = Query(default="pending", alias="status", pattern=_FOLLOW_UP_STATUS),
    window: str | None = Query(default=None, pattern=r"^(today|overdue|upcoming|week)$"),
    owner_id: uuid.UUID | None = None,
    q: str | None = None,
    kind: str | None = Query(default=None, pattern=r"^(lead|customer)$"),
    due_from: datetime | None = None,
    due_to: datetime | None = None,
) -> Response:
    """The current view as CSV — same scope, same filters, no more rows."""
    csv_text = svc.export_follow_ups_csv(
        db, viewer, status=status_filter, window=window, owner_id=owner_id, q=q,
        kind=kind, due_from=due_from, due_to=due_to,
    )
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="follow-ups-{date.today()}.csv"'},
    )


@router.post("/follow-ups/import", response_model=S.FollowUpImportResult)
def import_follow_ups(
    payload: S.FollowUpImportIn, viewer: CurrentUser, db: DbSession
) -> S.FollowUpImportResult:
    return svc.import_follow_ups(db, viewer, payload)


@router.get("/follow-ups", response_model=list[S.FollowUpOut])
def list_follow_ups(
    viewer: CurrentUser,
    db: DbSession,
    status_filter: str | None = Query(default="pending", alias="status", pattern=_FOLLOW_UP_STATUS),
    window: str | None = Query(default=None, pattern=r"^(today|overdue|upcoming|week)$"),
    owner_id: uuid.UUID | None = None,
    q: str | None = None,
    kind: str | None = Query(default=None, pattern=r"^(lead|customer)$"),
    due_from: datetime | None = None,
    due_to: datetime | None = None,
) -> list[S.FollowUpOut]:
    # Aliased because `status` is also the FastAPI status module imported above
    # — the same collision projects.py and assets.py resolve the same way.
    return svc.list_follow_ups(db, viewer, status=status_filter, window=window,
                               owner_id=owner_id, q=q, kind=kind,
                               due_from=due_from, due_to=due_to)


@router.post("/follow-ups", response_model=S.FollowUpOut, status_code=status.HTTP_201_CREATED)
def create_follow_up(payload: S.FollowUpIn, viewer: CurrentUser, db: DbSession) -> S.FollowUpOut:
    return svc.create_follow_up(db, viewer, payload)


@router.post("/follow-ups/{follow_up_id}/complete", response_model=S.FollowUpOut)
def complete_follow_up(
    follow_up_id: uuid.UUID, payload: S.FollowUpComplete, viewer: CurrentUser, db: DbSession
) -> S.FollowUpOut:
    return svc.complete_follow_up(db, viewer, follow_up_id, payload)


@router.delete("/follow-ups/{follow_up_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def cancel_follow_up(
    follow_up_id: uuid.UUID, viewer: CurrentUser, db: DbSession, permanent: bool = False
) -> None:
    # Plain DELETE cancels (the row stays in history); ?permanent=true removes it.
    if permanent:
        svc.delete_follow_up(db, viewer, follow_up_id)
    else:
        svc.cancel_follow_up(db, viewer, follow_up_id)


# --------------------------------------------------------------------------- #
# Customers
# --------------------------------------------------------------------------- #


@router.get("/customers", response_model=list[S.CustomerOut])
def list_customers(
    viewer: CurrentUser,
    db: DbSession,
    q: str | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    manager_id: uuid.UUID | None = None,
    renewal: str | None = Query(default=None, pattern=r"^(due|expired)$"),
) -> list[S.CustomerOut]:
    svc.ensure_defaults(db, viewer.org_id)
    return svc.list_customers(
        db, viewer, q=q, status=status_filter, manager_id=manager_id, renewal=renewal
    )


@router.post("/customers", response_model=S.CustomerOut, status_code=status.HTTP_201_CREATED)
def create_customer(
    payload: S.CustomerIn, viewer: CurrentUser, db: DbSession, request: Request
) -> S.CustomerOut:
    return svc.create_customer(db, viewer, payload, request=request)


@router.get("/customers/{customer_id}", response_model=S.CustomerDetailOut)
def customer_detail(
    customer_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> S.CustomerDetailOut:
    return svc.customer_detail(db, viewer, customer_id)


@router.patch("/customers/{customer_id}", response_model=S.CustomerOut)
def update_customer(
    customer_id: uuid.UUID, payload: S.CustomerPatch, viewer: CurrentUser, db: DbSession
) -> S.CustomerOut:
    return svc.update_customer(db, viewer, customer_id, payload)


@router.delete("/customers/{customer_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_customer(
    customer_id: uuid.UUID, viewer: CurrentUser, db: DbSession, request: Request
) -> None:
    svc.delete_customer(db, viewer, customer_id, request=request)


@router.post("/customers/{customer_id}/plans", response_model=S.CustomerPlanOut,
             status_code=status.HTTP_201_CREATED)
def add_plan(
    customer_id: uuid.UUID, payload: S.CustomerPlanIn, viewer: CurrentUser, db: DbSession
) -> S.CustomerPlanOut:
    return svc.add_plan(db, viewer, customer_id, payload)


@router.put("/plans/{plan_row_id}", response_model=S.CustomerPlanOut)
def update_plan(
    plan_row_id: uuid.UUID, payload: S.CustomerPlanIn, viewer: CurrentUser, db: DbSession
) -> S.CustomerPlanOut:
    return svc.update_plan(db, viewer, plan_row_id, payload)


@router.delete("/plans/{plan_row_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_plan(plan_row_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> None:
    svc.delete_plan(db, viewer, plan_row_id)


# --------------------------------------------------------------------------- #
# Support desk
# --------------------------------------------------------------------------- #


@router.get("/interactions", response_model=list[S.InteractionOut])
def list_interactions(
    viewer: CurrentUser,
    db: DbSession,
    customer_id: uuid.UUID | None = None,
    status_filter: str | None = Query(default=None, alias="status", pattern=r"^(open|closed)$"),
    limit: int = Query(default=100, ge=1, le=500),
) -> list[S.InteractionOut]:
    return svc.list_interactions(db, viewer, customer_id=customer_id,
                                 status=status_filter, limit=limit)


@router.get("/interactions/summary", response_model=S.SupportSummary)
def support_summary(viewer: CurrentUser, db: DbSession) -> S.SupportSummary:
    return svc.support_summary(db, viewer)


@router.post("/interactions", response_model=S.InteractionOut, status_code=status.HTTP_201_CREATED)
def log_interaction(
    payload: S.InteractionIn, viewer: CurrentUser, db: DbSession
) -> S.InteractionOut:
    return svc.log_interaction(db, viewer, payload)


@router.post("/interactions/{interaction_id}/close", response_model=S.InteractionOut)
def close_interaction(
    interaction_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> S.InteractionOut:
    return svc.close_interaction(db, viewer, interaction_id)


# --------------------------------------------------------------------------- #
# Visits
# --------------------------------------------------------------------------- #


_VISIT_STATUS = r"^(scheduled|in_progress|completed|cancelled)$"
_VISIT_PRIORITY = r"^(low|medium|high|urgent)$"


@router.get("/visits", response_model=list[S.VisitOut])
def list_visits(
    viewer: CurrentUser,
    db: DbSession,
    q: str | None = None,
    status_filter: str | None = Query(default=None, alias="status", pattern=_VISIT_STATUS),
    visit_type_id: uuid.UUID | None = None,
    employee_id: uuid.UUID | None = None,
    priority: str | None = Query(default=None, pattern=_VISIT_PRIORITY),
    date_from: date | None = None,
    date_to: date | None = None,
) -> list[S.VisitOut]:
    svc.ensure_defaults(db, viewer.org_id)
    return svc.list_visits(
        db, viewer, q=q, status=status_filter, visit_type_id=visit_type_id,
        employee_id=employee_id, priority=priority, date_from=date_from, date_to=date_to,
    )


@router.get("/visits/export")
def export_visits(
    viewer: CurrentUser,
    db: DbSession,
    q: str | None = None,
    status_filter: str | None = Query(default=None, alias="status", pattern=_VISIT_STATUS),
    visit_type_id: uuid.UUID | None = None,
    employee_id: uuid.UUID | None = None,
    priority: str | None = Query(default=None, pattern=_VISIT_PRIORITY),
    date_from: date | None = None,
    date_to: date | None = None,
) -> Response:
    """The current view as CSV — same scope, same filters, no more rows."""
    csv_text = svc.export_visits_csv(
        db, viewer, q=q, status=status_filter, visit_type_id=visit_type_id,
        employee_id=employee_id, priority=priority, date_from=date_from, date_to=date_to,
    )
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="visits-{date.today()}.csv"'},
    )


@router.get("/visits/summary", response_model=S.VisitSummary)
def visit_summary(viewer: CurrentUser, db: DbSession) -> S.VisitSummary:
    return svc.visit_summary(db, viewer)


@router.post("/visits", response_model=S.VisitOut, status_code=status.HTTP_201_CREATED)
def create_visit(payload: S.VisitIn, viewer: CurrentUser, db: DbSession) -> S.VisitOut:
    return svc.create_visit(db, viewer, payload)


@router.patch("/visits/{visit_id}", response_model=S.VisitOut)
def update_visit(
    visit_id: uuid.UUID, payload: S.VisitPatch, viewer: CurrentUser, db: DbSession
) -> S.VisitOut:
    return svc.update_visit(db, viewer, visit_id, payload)


@router.post("/visits/{visit_id}/otp")
def issue_otp(visit_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> dict:
    """Mint the arrival code and hand it back to whoever is dispatching.

    The product has no SMS channel, so the code is *shown*, not sent — see the
    note on ``services.crm.issue_visit_otp``.
    """
    return {"otp": svc.issue_visit_otp(db, viewer, visit_id)}


@router.post("/visits/{visit_id}/start", response_model=S.VisitOut)
def start_visit(
    visit_id: uuid.UUID, payload: S.VisitCheckIn, viewer: CurrentUser, db: DbSession
) -> S.VisitOut:
    return svc.start_visit(db, viewer, visit_id, payload)


@router.post("/visits/{visit_id}/close", response_model=S.VisitOut)
def close_visit(
    visit_id: uuid.UUID, payload: S.VisitCloseIn, viewer: CurrentUser, db: DbSession
) -> S.VisitOut:
    return svc.close_visit(db, viewer, visit_id, payload)


@router.delete("/visits/{visit_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_visit(visit_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> None:
    svc.delete_visit(db, viewer, visit_id)


@router.post("/visits/{visit_id}/cancel", response_model=S.VisitOut)
def cancel_visit(visit_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> S.VisitOut:
    return svc.cancel_visit(db, viewer, visit_id)


# --------------------------------------------------------------------------- #
# Quotations
# --------------------------------------------------------------------------- #


@router.get("/quotations", response_model=list[S.QuotationRowOut])
def list_quotations(
    viewer: CurrentUser,
    db: DbSession,
    status_filter: str | None = Query(default=None, alias="status"),
    q: str | None = None,
) -> list[S.QuotationRowOut]:
    return svc.list_quotations(db, viewer, status=status_filter, q=q)


@router.get("/quotations/summary", response_model=S.QuotationSummary)
def quotation_summary(viewer: CurrentUser, db: DbSession) -> S.QuotationSummary:
    return svc.quotation_summary(db, viewer)


@router.post("/quotations", response_model=S.QuotationOut, status_code=status.HTTP_201_CREATED)
def create_quotation(
    payload: S.QuotationIn, viewer: CurrentUser, db: DbSession, request: Request
) -> S.QuotationOut:
    return svc.create_quotation(db, viewer, payload, request=request)


@router.get("/quotations/{quotation_id}", response_model=S.QuotationOut)
def read_quotation(quotation_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> S.QuotationOut:
    return svc.get_quotation(db, viewer, quotation_id)


@router.put("/quotations/{quotation_id}", response_model=S.QuotationOut)
def update_quotation(
    quotation_id: uuid.UUID, payload: S.QuotationIn, viewer: CurrentUser, db: DbSession
) -> S.QuotationOut:
    return svc.update_quotation(db, viewer, quotation_id, payload)


@router.post("/quotations/{quotation_id}/status", response_model=S.QuotationOut)
def set_quotation_status(
    quotation_id: uuid.UUID, payload: S.QuotationStatusIn, viewer: CurrentUser, db: DbSession
) -> S.QuotationOut:
    return svc.set_quotation_status(db, viewer, quotation_id, payload)


@router.post("/quotations/{quotation_id}/duplicate", response_model=S.QuotationOut,
             status_code=status.HTTP_201_CREATED)
def duplicate_quotation(
    quotation_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> S.QuotationOut:
    return svc.duplicate_quotation(db, viewer, quotation_id)


@router.delete("/quotations/{quotation_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_quotation(quotation_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> None:
    svc.delete_quotation(db, viewer, quotation_id)


# --------------------------------------------------------------------------- #
# Reminders
# --------------------------------------------------------------------------- #


@router.get("/reminders", response_model=list[S.ReminderOut])
def list_reminders(viewer: CurrentUser, db: DbSession) -> list[S.ReminderOut]:
    return svc.list_reminders(db, viewer)


@router.get("/reminders/history", response_model=list[S.ReminderRunOut])
def reminder_history(
    viewer: CurrentUser, db: DbSession, limit: int = Query(default=100, ge=1, le=500)
) -> list[S.ReminderRunOut]:
    return svc.reminder_history(db, viewer, limit=limit)


@router.post("/reminders", response_model=S.ReminderOut, status_code=status.HTTP_201_CREATED)
def create_reminder(payload: S.ReminderIn, viewer: CurrentUser, db: DbSession) -> S.ReminderOut:
    return svc.save_reminder(db, viewer, payload)


@router.put("/reminders/{reminder_id}", response_model=S.ReminderOut)
def update_reminder(
    reminder_id: uuid.UUID, payload: S.ReminderIn, viewer: CurrentUser, db: DbSession
) -> S.ReminderOut:
    return svc.save_reminder(db, viewer, payload, reminder_id=reminder_id)


@router.post("/reminders/{reminder_id}/active", response_model=S.ReminderOut)
def toggle_reminder(
    reminder_id: uuid.UUID, active: bool, viewer: CurrentUser, db: DbSession
) -> S.ReminderOut:
    return svc.set_reminder_active(db, viewer, reminder_id, active)


@router.delete("/reminders/{reminder_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_reminder(reminder_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> None:
    svc.delete_reminder(db, viewer, reminder_id)


# --------------------------------------------------------------------------- #
# Public intake
#
# The one endpoint in this file with no CurrentUser. It authenticates on the
# token in the path and on nothing else, so:
#
# * the token is compared in constant time and never echoed back,
# * an unknown token answers 404 rather than 401 — an integration pointed at the
#   wrong workspace should not be told the workspace exists,
# * and a valid call always answers 200, even for a duplicate, because the
#   caller is Meta and an error status there disables the subscription.
# --------------------------------------------------------------------------- #


@router.post("/intake/{token}", status_code=status.HTTP_200_OK)
def capture_lead(
    token: str, payload: S.LeadCaptureIn, tenant: CurrentTenant, db: DbSession
) -> dict:
    import secrets as _secrets

    from sqlalchemy import select

    from app.models import CrmSettings, Organization

    settings = db.scalar(select(CrmSettings).where(CrmSettings.org_id == tenant.id))
    if (
        settings is None
        or not settings.intake_enabled
        or not settings.intake_token
        or not _secrets.compare_digest(token, settings.intake_token)
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")

    org = db.get(Organization, tenant.id)
    lead = svc.capture_lead(db, org, payload)
    # The code and nothing else: the caller needs a reference to log, and
    # anything more would be handing an unauthenticated client the pipeline.
    return {"ok": True, "lead_code": lead.code}
