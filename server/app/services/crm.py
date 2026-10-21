"""CRM domain logic: leads, follow-ups, customers, visits, quotations, reminders.

``api/v1/crm.py`` only maps HTTP onto the functions here. Four rules hold across
the whole module and are the things a reader would otherwise have to infer:

**1. Scope is resolved once, at the top, and passed down.** ``visible_owner_ids``
answers "whose pipeline may this person see" using the same
``services.hierarchy`` the rest of the product uses — a salesperson sees their
own leads, a manager their team's, an administrator everything. No query below
re-derives it, and none of them may be called without it: the whole module is
"My Leads", and a missing scope filter is one salesperson reading another's
pipeline.

**2. The denormalised ``CrmLead.next_follow_up_at`` is written here and nowhere
else.** It exists so the list and the dashboard counters need no correlated
subquery per row, and it is only correct because ``_resync_next_follow_up`` is
called by every path that creates, completes or cancels a follow-up. If you add
a fifth such path, call it too.

**3. Numbering goes through ``next_number``, inside the caller's
transaction.** It reads and increments a counter row; the unique constraint on
the document number is what makes a concurrent duplicate an error rather than
two customers holding QT-2026-0007.

**4. Masters are seeded, not required.** ``ensure_defaults`` runs on the first
read of any master list, so a workspace that has never opened Settings still has
statuses to put a lead in. It is idempotent and never overwrites an edit — it
only inserts what is missing, and only while the table is empty for that master.
"""

from __future__ import annotations

import re
import secrets
import uuid
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Iterable, Sequence

from fastapi import HTTPException, Request
from fastapi import status as http_status
from sqlalchemy import Select, delete, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.api.deps import audit
from app.models import (
    CrmActivity,
    CrmCity,
    CrmCountry,
    CrmCounter,
    CrmCustomer,
    CrmCustomerPlan,
    CrmDisposition,
    CrmDistrict,
    CrmFollowUp,
    CrmIndustry,
    CrmInteraction,
    CrmLead,
    CrmLeadSource,
    CrmLeadStatus,
    CrmLostReason,
    CrmOpportunityStage,
    CrmPlan,
    CrmProduct,
    CrmQuotation,
    CrmQuotationLine,
    CrmReminder,
    CrmReminderRecipient,
    CrmReminderRun,
    CrmSettings,
    CrmState,
    CrmTerritory,
    CrmVisit,
    CrmVisitType,
    CrmCampaign,
    CrmCompetitor,
    CrmContactDesignation,
    CustomerStatus,
    ForecastCategory,
    FollowUpStatus,
    InteractionStatus,
    LostOutcome,
    OpportunityBehaviour,
    Organization,
    QuotationStatus,
    StatusBehaviour,
    User,
    VisitStatus,
)
from app.schemas import crm as S

MONEY = Decimal("0.01")
QTY = Decimal("0.001")


def _money(value: Decimal | int | float | str) -> Decimal:
    """Round half-up to paise.

    Half-up rather than Python's default banker's rounding: an invoice that
    rounds 2.685 down to 2.68 disagrees with every accounting package the
    customer will check it against, and "the software rounds differently" is not
    a conversation anybody wants to have about tax.
    """
    return Decimal(value).quantize(MONEY, rounding=ROUND_HALF_UP)


def _aware(value: datetime | None) -> datetime | None:
    """Read a timestamp back as UTC-aware.

    SQLite returns naive datetimes even from ``DateTime(timezone=True)``, and
    comparing one against ``now(timezone.utc)`` raises rather than answering —
    so every overdue check in this module would 500 instead of being wrong,
    which is at least honest but not useful.
    """
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# Scope
# --------------------------------------------------------------------------- #


def visible_owner_ids(db: Session, viewer: User) -> set[uuid.UUID] | None:
    """Whose pipeline this person may read. ``None`` means everybody's.

    ``None`` rather than "the set of all users" on purpose: a company-scoped
    reader must also see the leads owned by *nobody*, and an explicit set would
    exclude the unassigned pool that a manager's whole job is to hand out.
    """
    from app.services.hierarchy import visible_user_ids

    if viewer.sees_others and viewer.role_enum.can_administer:
        return None
    if viewer.sees_others:
        return set(visible_user_ids(db, viewer))
    return {viewer.id}


def _scoped(stmt: Select, column, scope: set[uuid.UUID] | None) -> Select:
    """Apply an owner scope to a statement.

    Rows with a NULL owner are included for a scoped reader as well. An
    unassigned lead belongs to the queue, not to nobody: hiding it would mean a
    salesperson cannot pick up work that was captured for them to pick up.
    """
    if scope is None:
        return stmt
    return stmt.where(or_(column.in_(scope), column.is_(None)))


def can_administer_crm(user: User) -> bool:
    """Who may edit masters, settings and reminders.

    The CRM has no permission flag of its own on ``users`` — adding one would be
    a migration on a table every module reads — so this is the role check.
    Restricts only: it never widens what ``sees_others`` already allows.
    """
    return user.role_enum.can_administer


def require_admin_crm(user: User) -> None:
    if not can_administer_crm(user):
        raise HTTPException(
            http_status.HTTP_403_FORBIDDEN,
            detail={
                "reason": "permission_denied",
                "message": "Your account is not permitted to change CRM configuration.",
            },
        )


# --------------------------------------------------------------------------- #
# Settings, numbering and seeding
# --------------------------------------------------------------------------- #


def get_settings(db: Session, org_id: uuid.UUID) -> CrmSettings:
    """The org's CRM settings, created on first read.

    Created rather than defaulted-in-memory so that the intake token has
    somewhere to live the moment somebody switches capture on.
    """
    row = db.scalar(select(CrmSettings).where(CrmSettings.org_id == org_id))
    if row is None:
        row = CrmSettings(org_id=org_id)
        db.add(row)
        db.flush()
    return row


def next_number(db: Session, org_id: uuid.UUID, series: str, *, period: str = "") -> int:
    """Hand out the next number in a series, inside the caller's transaction.

    Read-modify-write with no lock, which is deliberate and safe *because the
    document tables carry a unique constraint on the number*: two concurrent
    callers can read the same counter, and the second insert then fails on that
    constraint rather than issuing a duplicate. The caller retries. Taking a row
    lock here would serialise every quotation save in the workspace to buy the
    same guarantee the constraint already gives.
    """
    row = db.scalar(
        select(CrmCounter).where(
            CrmCounter.org_id == org_id,
            CrmCounter.series == series,
            CrmCounter.period == period,
        )
    )
    if row is None:
        row = CrmCounter(org_id=org_id, series=series, period=period, last_number=0)
        db.add(row)
    row.last_number += 1
    db.flush()
    return row.last_number


def _lead_code(db: Session, org_id: uuid.UUID) -> str:
    """A short, readable, non-sequential lead reference.

    Non-sequential on purpose: a lead code is read out on the phone and quoted
    in a WhatsApp thread, and a sequential one tells a competitor exactly how
    many enquiries the company gets a week. Six hex characters is 16 million
    codes; the loop retries on the unique constraint rather than assuming.
    """
    for _ in range(8):
        candidate = secrets.token_hex(3).upper()
        exists = db.scalar(
            select(CrmLead.id).where(CrmLead.org_id == org_id, CrmLead.code == candidate)
        )
        if not exists:
            return candidate
    # Vanishingly unlikely; fall back to something that cannot collide.
    return uuid.uuid4().hex[:10].upper()


DEFAULT_STATUSES: list[tuple[str, str, str]] = [
    ("Pending", StatusBehaviour.DEFAULT.value, "#F59E0B"),
    ("Contacted", StatusBehaviour.IN_PROGRESS.value, "#3882F6"),
    ("Qualified", StatusBehaviour.IN_PROGRESS.value, "#8B5CF6"),
    ("Won", StatusBehaviour.WON.value, "#22C55E"),
    ("Lost", StatusBehaviour.LOST.value, "#EF4444"),
]

DEFAULT_SOURCES = ["Website", "Meta Ads", "Google Ads", "Referral", "Walk-in", "Cold Call"]

DEFAULT_DISPOSITIONS: list[tuple[str, bool]] = [
    ("Update Call", False),
    ("Enquiry", False),
    ("Complaint", False),
    ("Renewal", False),
    ("Call Back Later", False),
    ("Resolved", True),
    ("Not Reachable", False),
]

DEFAULT_VISIT_TYPES: list[tuple[str, str, bool]] = [
    ("Service Visit", "#3882F6", False),
    ("Sales Visit", "#8B5CF6", False),
    ("Demo", "#22C55E", False),
    ("Collection", "#F59E0B", True),
    ("Installation", "#0EA5E9", False),
]

DEFAULT_INDUSTRIES = [
    "Manufacturing", "Retail", "Healthcare", "Education", "IT & Software",
    "Real Estate", "Hospitality", "Logistics", "Professional Services",
]

#: India's states, with the GST state code that decides CGST+SGST against IGST.
#: Seeded because the product sells here first and an empty geography master
#: makes the quotation builder unusable on day one. A workspace selling
#: elsewhere adds its own; nothing here is privileged.
DEFAULT_STATES: list[tuple[str, str]] = [
    ("Andhra Pradesh", "37"), ("Assam", "18"), ("Bihar", "10"), ("Chhattisgarh", "22"),
    ("Delhi", "07"), ("Goa", "30"), ("Gujarat", "24"), ("Haryana", "06"),
    ("Himachal Pradesh", "02"), ("Jammu and Kashmir", "01"), ("Jharkhand", "20"),
    ("Karnataka", "29"), ("Kerala", "32"), ("Madhya Pradesh", "23"), ("Maharashtra", "27"),
    ("Odisha", "21"), ("Punjab", "03"), ("Rajasthan", "08"), ("Tamil Nadu", "33"),
    ("Telangana", "36"), ("Uttar Pradesh", "09"), ("Uttarakhand", "05"), ("West Bengal", "19"),
]


#: The opportunity pipeline a new workspace opens with: (name, behaviour,
#: probability, forecast bucket, days before stale, colour).
DEFAULT_OPPORTUNITY_STAGES: list[tuple[str, str, int, str | None, int, str]] = [
    ("Qualification", OpportunityBehaviour.OPEN.value, 10, ForecastCategory.UPSIDE.value, 21, "#94A3B8"),
    ("Requirement Analysis", OpportunityBehaviour.OPEN.value, 25, ForecastCategory.PIPELINE.value, 30, "#3882F6"),
    ("Solution & Proposal", OpportunityBehaviour.OPEN.value, 40, ForecastCategory.PIPELINE.value, 30, "#8B5CF6"),
    ("Negotiation", OpportunityBehaviour.OPEN.value, 65, ForecastCategory.BEST_CASE.value, 21, "#F59E0B"),
    ("Verbal Commit", OpportunityBehaviour.OPEN.value, 90, ForecastCategory.COMMIT.value, 14, "#0EA5E9"),
    ("Won", OpportunityBehaviour.WON.value, 100, None, 0, "#22C55E"),
    ("Lost", OpportunityBehaviour.LOST.value, 0, None, 0, "#EF4444"),
    ("No Decision", OpportunityBehaviour.NO_DECISION.value, 0, None, 0, "#64748B"),
]

#: (name, outcome, requires a competitor)
DEFAULT_LOST_REASONS: list[tuple[str, str, bool]] = [
    ("Lost to competitor", LostOutcome.LOST.value, True),
    ("Price too high", LostOutcome.LOST.value, False),
    ("Product / feature gap", LostOutcome.LOST.value, False),
    ("Relationship with incumbent", LostOutcome.LOST.value, True),
    ("Did not qualify technically", LostOutcome.LOST.value, False),
    ("Budget not available", LostOutcome.NO_DECISION.value, False),
    ("Project deferred / cancelled", LostOutcome.NO_DECISION.value, False),
    ("No response from customer", LostOutcome.NO_DECISION.value, False),
]

DEFAULT_CONTACT_DESIGNATIONS = [
    "Managing Director / CEO", "CIO / CTO", "IT Head", "Purchase Manager",
    "Finance Head", "Project Manager", "Technical Lead", "Administrator",
]

#: India's sales zones, by state name. Mapped onto the seeded state master, so
#: a workspace that renamed or removed a state just gets a smaller zone.
DEFAULT_TERRITORIES: list[tuple[str, str, list[str]]] = [
    ("North", "N", [
        "Delhi", "Haryana", "Punjab", "Himachal Pradesh", "Jammu and Kashmir",
        "Uttarakhand", "Uttar Pradesh", "Rajasthan",
    ]),
    ("West", "W", ["Gujarat", "Maharashtra", "Goa"]),
    ("Central", "C", ["Madhya Pradesh", "Chhattisgarh"]),
    ("South", "S", ["Andhra Pradesh", "Karnataka", "Kerala", "Tamil Nadu", "Telangana"]),
    ("East", "E", ["West Bengal", "Odisha", "Bihar", "Jharkhand", "Assam"]),
]


def _empty(db: Session, model: Any, org_id: uuid.UUID) -> bool:
    return not db.scalar(select(func.count()).select_from(model).where(model.org_id == org_id))


def _ensure_sales_defaults(db: Session, org_id: uuid.UUID) -> None:
    """Seed the opportunity-side masters. Same per-master rule as the rest."""
    if _empty(db, CrmOpportunityStage, org_id):
        for order, (name, behaviour, probability, bucket, stale, colour) in enumerate(
            DEFAULT_OPPORTUNITY_STAGES
        ):
            db.add(CrmOpportunityStage(
                org_id=org_id, name=name, behaviour=behaviour, probability=probability,
                forecast_category=bucket, stale_after_days=stale, colour=colour,
                sort_order=order,
            ))

    if _empty(db, CrmLostReason, org_id):
        for order, (name, outcome, needs_competitor) in enumerate(DEFAULT_LOST_REASONS):
            db.add(CrmLostReason(
                org_id=org_id, name=name, outcome=outcome,
                requires_competitor=needs_competitor, sort_order=order,
            ))

    if _empty(db, CrmContactDesignation, org_id):
        for order, name in enumerate(DEFAULT_CONTACT_DESIGNATIONS):
            db.add(CrmContactDesignation(org_id=org_id, name=name, sort_order=order))

    if _empty(db, CrmTerritory, org_id):
        db.flush()  # the states seeded a moment ago must be visible to the lookup
        by_name = {
            name: str(state_id)
            for state_id, name in db.execute(
                select(CrmState.id, CrmState.name).where(CrmState.org_id == org_id)
            )
        }
        for order, (name, code, states) in enumerate(DEFAULT_TERRITORIES):
            db.add(CrmTerritory(
                org_id=org_id, name=name, code=code, sort_order=order,
                state_ids=[by_name[state] for state in states if state in by_name],
            ))


def ensure_defaults(db: Session, org_id: uuid.UUID) -> None:
    """Seed each empty master. Idempotent, and never touches a non-empty one.

    Per master rather than per organisation: a company that deleted every lead
    source deliberately must not have them grow back, but a company that has
    statuses and no visit types should still get visit types when they first
    open Visits.
    """
    if not db.scalar(select(func.count()).select_from(CrmLeadStatus).where(
        CrmLeadStatus.org_id == org_id
    )):
        for order, (name, behaviour, colour) in enumerate(DEFAULT_STATUSES):
            db.add(CrmLeadStatus(
                org_id=org_id, name=name, behaviour=behaviour, colour=colour, sort_order=order
            ))

    if not db.scalar(select(func.count()).select_from(CrmLeadSource).where(
        CrmLeadSource.org_id == org_id
    )):
        for index, name in enumerate(DEFAULT_SOURCES):
            db.add(CrmLeadSource(org_id=org_id, name=name, is_intake_default=index == 1))

    if not db.scalar(select(func.count()).select_from(CrmDisposition).where(
        CrmDisposition.org_id == org_id
    )):
        for order, (name, closes) in enumerate(DEFAULT_DISPOSITIONS):
            db.add(CrmDisposition(
                org_id=org_id, name=name, closes_interaction=closes, sort_order=order
            ))

    if not db.scalar(select(func.count()).select_from(CrmVisitType).where(
        CrmVisitType.org_id == org_id
    )):
        for order, (name, colour, otp) in enumerate(DEFAULT_VISIT_TYPES):
            db.add(CrmVisitType(
                org_id=org_id, name=name, colour=colour, requires_otp=otp, sort_order=order
            ))

    if not db.scalar(select(func.count()).select_from(CrmIndustry).where(
        CrmIndustry.org_id == org_id
    )):
        for name in DEFAULT_INDUSTRIES:
            db.add(CrmIndustry(org_id=org_id, name=name))

    if not db.scalar(select(func.count()).select_from(CrmCountry).where(
        CrmCountry.org_id == org_id
    )):
        india = CrmCountry(org_id=org_id, name="India", iso2="IN", dial_code="+91")
        db.add(india)
        db.flush()
        for name, code in DEFAULT_STATES:
            db.add(CrmState(org_id=org_id, country_id=india.id, name=name, gst_code=code))

    _ensure_sales_defaults(db, org_id)
    db.commit()


def default_status(db: Session, org_id: uuid.UUID) -> CrmLeadStatus | None:
    """Where a new lead lands.

    The stage marked ``default``, or failing that the first by sort order — a
    company can delete the default stage, and a lead with no status is worse
    than a lead in the wrong one.
    """
    stmt = select(CrmLeadStatus).where(
        CrmLeadStatus.org_id == org_id, CrmLeadStatus.is_active.is_(True)
    )
    return (
        db.scalar(stmt.where(CrmLeadStatus.behaviour == StatusBehaviour.DEFAULT.value))
        or db.scalar(stmt.order_by(CrmLeadStatus.sort_order))
    )


def _statuses_by_behaviour(db: Session, org_id: uuid.UUID, behaviour: StatusBehaviour) -> list[uuid.UUID]:
    return list(
        db.scalars(
            select(CrmLeadStatus.id).where(
                CrmLeadStatus.org_id == org_id, CrmLeadStatus.behaviour == behaviour.value
            )
        )
    )


# --------------------------------------------------------------------------- #
# Masters CRUD
#
# One generic implementation over the simple masters, because eight
# copy-pasted create/update/delete triples is eight places for a missing
# ``org_id`` filter to hide.
# --------------------------------------------------------------------------- #

MASTER_MODELS: dict[str, Any] = {
    "statuses": CrmLeadStatus,
    "sources": CrmLeadSource,
    "industries": CrmIndustry,
    "countries": CrmCountry,
    "states": CrmState,
    "districts": CrmDistrict,
    "cities": CrmCity,
    "products": CrmProduct,
    "plans": CrmPlan,
    "dispositions": CrmDisposition,
    "visit-types": CrmVisitType,
    "territories": CrmTerritory,
    "campaigns": CrmCampaign,
    "competitors": CrmCompetitor,
    "contact-designations": CrmContactDesignation,
    "lost-reasons": CrmLostReason,
    "opportunity-stages": CrmOpportunityStage,
}

#: What blocks deleting a master row, and the sentence the refusal uses. A
#: master that something points at is deactivated, never deleted: the lead
#: created last March has to keep saying which source it came from.
MASTER_GUARDS: dict[str, list[tuple[Any, Any, str]]] = {
    "statuses": [(CrmLead, CrmLead.status_id, "lead")],
    "sources": [
        (CrmLead, CrmLead.source_id, "lead"),
        (CrmCustomer, CrmCustomer.source_id, "customer"),
        (CrmCampaign, CrmCampaign.source_id, "campaign"),
    ],
    "industries": [
        (CrmLead, CrmLead.industry_id, "lead"),
        (CrmCustomer, CrmCustomer.industry_id, "customer"),
    ],
    "products": [
        (CrmLead, CrmLead.product_id, "lead"),
        (CrmCustomerPlan, CrmCustomerPlan.product_id, "customer plan"),
        (CrmQuotationLine, CrmQuotationLine.product_id, "quotation line"),
    ],
    "plans": [(CrmCustomerPlan, CrmCustomerPlan.plan_id, "customer plan")],
    "dispositions": [(CrmInteraction, CrmInteraction.disposition_id, "logged call")],
    "visit-types": [(CrmVisit, CrmVisit.visit_type_id, "visit")],
    "states": [(CrmLead, CrmLead.state_id, "lead"), (CrmCustomer, CrmCustomer.state_id, "customer")],
    "cities": [(CrmLead, CrmLead.city_id, "lead"), (CrmCustomer, CrmCustomer.city_id, "customer")],
    "districts": [(CrmCity, CrmCity.district_id, "city")],
    "countries": [(CrmCustomer, CrmCustomer.country_id, "customer")],
}


def _refuse(message: str, reason: str = "invalid") -> HTTPException:
    return HTTPException(
        http_status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"reason": reason, "message": message}
    )


def prepare_master(
    db: Session, org_id: uuid.UUID, kind: str, data: dict[str, Any], row_id: uuid.UUID | None
) -> dict[str, Any]:
    """Check a master write against the rest of the workspace.

    The schemas check a row on its own; this checks what only the database
    knows -- that a referenced state, source or manager is this tenant's, and
    that a state is not already in another territory. Returns the values to
    store (territory state ids become strings for the JSON column).
    """
    if kind == "territories":
        wanted = list(dict.fromkeys(data.get("state_ids") or []))
        if wanted:
            found = set(db.scalars(
                select(CrmState.id).where(CrmState.org_id == org_id, CrmState.id.in_(wanted))
            ))
            if len(found) != len(wanted):
                raise _refuse("One of the chosen states is not on this workspace's state list.")
            taken: dict[str, str] = {}
            others = select(CrmTerritory).where(CrmTerritory.org_id == org_id)
            if row_id is not None:
                others = others.where(CrmTerritory.id != row_id)
            for other in db.scalars(others):
                for state_id in other.state_ids or []:
                    taken[str(state_id)] = other.name
            clashes = [str(state) for state in wanted if str(state) in taken]
            if clashes:
                names = dict(db.execute(
                    select(CrmState.id, CrmState.name).where(CrmState.id.in_(
                        [uuid.UUID(c) for c in clashes]
                    ))
                ).all())
                first = uuid.UUID(clashes[0])
                raise _refuse(
                    f"{names.get(first, 'A state')} is already in {taken[clashes[0]]}. "
                    "A state can sit in one territory only, or geography-based "
                    "assignment would not know where its leads go.",
                    reason="state_in_other_territory",
                )
        data["state_ids"] = [str(state) for state in wanted]
        manager_id = data.get("manager_id")
        if manager_id is not None:
            manager = db.get(User, manager_id)
            if manager is None or manager.org_id != org_id:
                raise _refuse("That territory manager is not in this workspace.")

    if kind in ("districts", "cities") and data.get("state_id") is not None:
        state = db.get(CrmState, data["state_id"])
        if state is None or state.org_id != org_id:
            raise _refuse("That state is not on this workspace's state list.")

    if kind == "cities" and data.get("district_id") is not None:
        district = db.get(CrmDistrict, data["district_id"])
        if district is None or district.org_id != org_id:
            raise _refuse("That district is not on this workspace's district list.")
        if district.state_id != data.get("state_id"):
            raise _refuse(
                f"{district.name} is a district of another state. Pick the city's own "
                "state, or a district inside it.",
                reason="district_state_mismatch",
            )

    if kind == "campaigns" and data.get("source_id") is not None:
        source = db.get(CrmLeadSource, data["source_id"])
        if source is None or source.org_id != org_id:
            raise _refuse("That lead source is not on this workspace's list.")

    if kind == "opportunity-stages":
        # The pipeline needs somewhere to put a new opportunity. Switching off
        # or re-purposing the last open stage would leave conversion with no
        # stage to land in, so it is refused here rather than at conversion.
        becomes_closed = data.get("behaviour") != OpportunityBehaviour.OPEN.value
        switched_off = data.get("is_active") is False
        if becomes_closed or switched_off:
            others_open = select(func.count()).select_from(CrmOpportunityStage).where(
                CrmOpportunityStage.org_id == org_id,
                CrmOpportunityStage.behaviour == OpportunityBehaviour.OPEN.value,
                CrmOpportunityStage.is_active.is_(True),
            )
            if row_id is not None:
                current = db.get(CrmOpportunityStage, row_id)
                if current is not None and current.behaviour == OpportunityBehaviour.OPEN.value:
                    others_open = others_open.where(CrmOpportunityStage.id != row_id)
                    if not db.scalar(others_open):
                        raise _refuse(
                            "This is the last open stage. Add another open stage before "
                            "closing or switching this one off.",
                            reason="last_open_stage",
                        )
    return data


def master_model(kind: str) -> Any:
    model = MASTER_MODELS.get(kind)
    if model is None:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Unknown master list")
    return model


def get_master(db: Session, org_id: uuid.UUID, kind: str, row_id: uuid.UUID) -> Any:
    model = master_model(kind)
    row = db.get(model, row_id)
    # 404 on the cross-tenant miss rather than 403: a 403 confirms the id exists
    # somewhere, which is itself a leak across a tenant boundary.
    if row is None or row.org_id != org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Not found")
    return row


def delete_master(db: Session, org_id: uuid.UUID, kind: str, row_id: uuid.UUID) -> None:
    """Delete a master row, or refuse with what is holding it."""
    row = get_master(db, org_id, kind, row_id)
    if kind == "opportunity-stages":
        # Same rule as switching it off: the last open stage has to stay.
        prepare_master(db, org_id, kind, {"behaviour": "open", "is_active": False}, row_id)
    for model, column, noun in MASTER_GUARDS.get(kind, []):
        used = db.scalar(
            select(func.count()).select_from(model).where(
                model.org_id == org_id, column == row_id
            )
        )
        if used:
            raise HTTPException(
                http_status.HTTP_409_CONFLICT,
                detail={
                    "reason": "master_in_use",
                    "message": (
                        f"{used} {noun}{'s' if used != 1 else ''} still use this entry. "
                        "Switch it off instead of deleting it — the history has to keep "
                        "saying what it said."
                    ),
                },
            )
    db.delete(row)
    db.commit()


# --------------------------------------------------------------------------- #
# Serialisation helpers
# --------------------------------------------------------------------------- #


def _lead_out(lead: CrmLead) -> S.LeadOut:
    return S.LeadOut(
        id=lead.id, code=lead.code, name=lead.name, company=lead.company, mobile=lead.mobile,
        whatsapp=lead.whatsapp, email=lead.email,
        status_id=lead.status_id,
        status_name=lead.status.name if lead.status else None,
        status_colour=lead.status.colour if lead.status else None,
        status_behaviour=lead.status.behaviour if lead.status else None,
        source_id=lead.source_id, source_name=lead.source.name if lead.source else None,
        industry_id=lead.industry_id, industry_name=lead.industry.name if lead.industry else None,
        product_id=lead.product_id, product_name=lead.product.name if lead.product else None,
        owner_id=lead.owner_id, owner_name=lead.owner.full_name if lead.owner else None,
        state_id=lead.state_id, state_name=lead.state.name if lead.state else None,
        city_id=lead.city_id, city_name=lead.city.name if lead.city else None,
        pincode=lead.pincode, address=lead.address, notes=lead.notes, value=lead.value,
        next_follow_up_at=lead.next_follow_up_at, last_contacted_at=lead.last_contacted_at,
        customer_id=lead.customer_id, converted_at=lead.converted_at,
        lost_reason=lead.lost_reason, created_at=lead.created_at, updated_at=lead.updated_at,
    )


def _follow_up_out(row: CrmFollowUp) -> S.FollowUpOut:
    subject = row.lead or row.customer
    due = _aware(row.due_at)
    return S.FollowUpOut(
        id=row.id, lead_id=row.lead_id, customer_id=row.customer_id,
        subject_name=subject.name if subject else None,
        subject_mobile=subject.mobile if subject else None,
        subject_kind="customer" if row.customer_id else "lead",
        owner_id=row.owner_id, owner_name=row.owner.full_name if row.owner else None,
        due_at=row.due_at, purpose=row.purpose, notes=row.notes, status=row.status,
        outcome=row.outcome, completed_at=row.completed_at, created_at=row.created_at,
        is_overdue=row.status == FollowUpStatus.PENDING.value and due is not None and due < _now(),
    )


def _plan_out(row: CrmCustomerPlan) -> S.CustomerPlanOut:
    days = (row.renewal_on - date.today()).days if row.renewal_on else None
    return S.CustomerPlanOut(
        id=row.id, customer_id=row.customer_id, product_id=row.product_id, plan_id=row.plan_id,
        product_name=row.product_name, plan_name=row.plan_name, start_on=row.start_on,
        end_on=row.end_on, renewal_on=row.renewal_on, amount=row.amount,
        payment_status=row.payment_status, status=row.status, notes=row.notes,
        days_to_renewal=days,
    )


def _customer_out(row: CrmCustomer) -> S.CustomerOut:
    plans = sorted(
        row.plans,
        # Soonest renewal leads; plans with no renewal date sort last but stay
        # visible, because a perpetual licence is still what this account owns.
        key=lambda p: (p.renewal_on is None, p.renewal_on or date.max),
    )
    return S.CustomerOut(
        id=row.id, code=row.code, name=row.name, company=row.company, mobile=row.mobile,
        whatsapp=row.whatsapp, email=row.email, customer_type=row.customer_type,
        industry_id=row.industry_id, industry_name=row.industry.name if row.industry else None,
        source_id=row.source_id, source_name=None,
        gstin=row.gstin, country_id=row.country_id,
        state_id=row.state_id, state_name=row.state.name if row.state else None,
        city_id=row.city_id, city_name=row.city.name if row.city else None,
        pincode=row.pincode, address=row.address,
        manager_id=row.manager_id, manager_name=row.manager.full_name if row.manager else None,
        status=row.status, notes=row.notes,
        converted_from_lead_id=row.converted_from_lead_id, created_at=row.created_at,
        primary_plan=_plan_out(plans[0]) if plans else None,
        plan_count=len(row.plans),
    )


def _interaction_out(row: CrmInteraction) -> S.InteractionOut:
    return S.InteractionOut(
        id=row.id, ticket_no=row.ticket_no, customer_id=row.customer_id,
        customer_name=row.customer.name if row.customer else None,
        direction=row.direction, disposition_id=row.disposition_id,
        disposition_name=row.disposition_name, status=row.status, remarks=row.remarks,
        staff_id=row.staff_id, staff_name=row.staff.full_name if row.staff else None,
        follow_up_id=row.follow_up_id,
        follow_up_due_at=row.follow_up.due_at if row.follow_up else None,
        closed_at=row.closed_at, created_at=row.created_at,
    )


def _visit_out(row: CrmVisit) -> S.VisitOut:
    return S.VisitOut(
        id=row.id, visit_no=row.visit_no, customer_id=row.customer_id,
        customer_name=row.customer.name if row.customer else None,
        customer_mobile=row.customer.mobile if row.customer else None,
        visit_type_id=row.visit_type_id, visit_type_name=row.visit_type_name,
        contact_person=row.contact_person, mobile=row.mobile,
        # Blank falls back to the customer's address rather than being copied at
        # create time, so correcting the customer corrects every open visit.
        address=row.address or (row.customer.address if row.customer else None),
        priority=row.priority, purpose=row.purpose, notes=row.notes,
        assigned_to=row.assigned_to,
        employee_name=row.employee.full_name if row.employee else None,
        scheduled_at=row.scheduled_at, started_at=row.started_at,
        completed_at=row.completed_at, status=row.status, outcome=row.outcome,
        duration_minutes=row.duration_minutes,
        otp_required=bool(row.visit_type.requires_otp) if row.visit_type else False,
        otp_verified=row.otp_verified_at is not None,
        created_at=row.created_at,
    )


def _line_out(row: CrmQuotationLine) -> S.QuotationLineOut:
    return S.QuotationLineOut.model_validate(row)


def _quotation_row_out(row: CrmQuotation) -> S.QuotationRowOut:
    return S.QuotationRowOut(
        id=row.id, number=row.number, customer_name=row.customer_name, company=row.company,
        quote_date=row.quote_date, valid_until=row.valid_until, status=row.status,
        grand_total=row.grand_total, created_by=row.created_by,
        created_by_name=row.creator.full_name if row.creator else None,
        lead_id=row.lead_id, customer_id=row.customer_id, created_at=row.created_at,
    )


def _quotation_out(row: CrmQuotation) -> S.QuotationOut:
    return S.QuotationOut(
        **_quotation_row_out(row).model_dump(),
        gstin=row.gstin, mobile=row.mobile, whatsapp=row.whatsapp, email=row.email,
        city=row.city, state=row.state, pincode=row.pincode,
        billing_address=row.billing_address, shipping_address=row.shipping_address,
        sub_total=row.sub_total, discount_total=row.discount_total,
        taxable_value=row.taxable_value, cgst=row.cgst, sgst=row.sgst, igst=row.igst,
        is_interstate=row.is_interstate, terms=row.terms, notes=row.notes,
        sent_at=row.sent_at, decided_at=row.decided_at,
        lines=[_line_out(line) for line in row.lines],
    )


# --------------------------------------------------------------------------- #
# Leads
# --------------------------------------------------------------------------- #

_LEAD_LOADERS = (
    selectinload(CrmLead.status),
    selectinload(CrmLead.source),
    selectinload(CrmLead.industry),
    selectinload(CrmLead.product),
    selectinload(CrmLead.owner),
    selectinload(CrmLead.state),
    selectinload(CrmLead.city),
)


def get_lead(db: Session, org_id: uuid.UUID, lead_id: uuid.UUID) -> CrmLead:
    lead = db.get(CrmLead, lead_id)
    if lead is None or lead.org_id != org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Lead not found")
    return lead


def _readable_lead(db: Session, viewer: User, lead_id: uuid.UUID) -> CrmLead:
    lead = get_lead(db, viewer.org_id, lead_id)
    scope = visible_owner_ids(db, viewer)
    if scope is not None and lead.owner_id is not None and lead.owner_id not in scope:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Lead not found")
    return lead


def list_leads(
    db: Session,
    viewer: User,
    *,
    q: str | None = None,
    status_id: uuid.UUID | None = None,
    source_id: uuid.UUID | None = None,
    owner_id: uuid.UUID | None = None,
    product_id: uuid.UUID | None = None,
    behaviour: str | None = None,
    follow_up: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    page: int = 1,
    page_size: int = 25,
) -> S.LeadPage:
    """The list behind My Leads, filtered, scoped and paginated.

    Paginated on the server, unlike the smaller registers in this product that
    filter in the browser: a pipeline is the one table here that genuinely
    reaches tens of thousands of rows, and shipping all of them to draw twenty-
    five is the difference between a page that opens and one that hangs.
    """
    scope = visible_owner_ids(db, viewer)
    stmt = select(CrmLead).where(CrmLead.org_id == viewer.org_id)
    stmt = _scoped(stmt, CrmLead.owner_id, scope)

    if q:
        needle = f"%{q.strip().lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(CrmLead.name).like(needle),
                func.lower(func.coalesce(CrmLead.company, "")).like(needle),
                CrmLead.mobile.like(needle),
                func.lower(func.coalesce(CrmLead.email, "")).like(needle),
                func.lower(CrmLead.code).like(needle),
            )
        )
    if status_id:
        stmt = stmt.where(CrmLead.status_id == status_id)
    if source_id:
        stmt = stmt.where(CrmLead.source_id == source_id)
    if product_id:
        stmt = stmt.where(CrmLead.product_id == product_id)
    if owner_id:
        stmt = stmt.where(CrmLead.owner_id == owner_id)
    if behaviour:
        ids = _statuses_by_behaviour(db, viewer.org_id, StatusBehaviour(behaviour))
        # An empty list would produce `IN ()`, which matches everything on some
        # backends and nothing on others. Say "nothing" explicitly.
        stmt = stmt.where(CrmLead.status_id.in_(ids)) if ids else stmt.where(False)
    if date_from:
        stmt = stmt.where(CrmLead.created_at >= datetime.combine(date_from, time.min, timezone.utc))
    if date_to:
        stmt = stmt.where(CrmLead.created_at <= datetime.combine(date_to, time.max, timezone.utc))

    now = _now()
    if follow_up == "today":
        start = datetime.combine(now.date(), time.min, timezone.utc)
        end = datetime.combine(now.date(), time.max, timezone.utc)
        stmt = stmt.where(CrmLead.next_follow_up_at.between(start, end))
    elif follow_up == "overdue":
        stmt = stmt.where(CrmLead.next_follow_up_at < now)
    elif follow_up == "upcoming":
        stmt = stmt.where(CrmLead.next_follow_up_at >= now)
    elif follow_up == "none":
        stmt = stmt.where(CrmLead.next_follow_up_at.is_(None))

    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    page = max(1, page)
    page_size = min(max(1, page_size), 200)
    rows = db.scalars(
        stmt.options(*_LEAD_LOADERS)
        .order_by(CrmLead.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return S.LeadPage(
        rows=[_lead_out(row) for row in rows], total=total, page=page, page_size=page_size
    )


def _log(
    db: Session,
    lead: CrmLead,
    actor: User | None,
    kind: str,
    body: str,
) -> None:
    """Append to a lead's timeline. Never updates, never deletes."""
    db.add(
        CrmActivity(
            org_id=lead.org_id,
            lead_id=lead.id,
            actor_id=actor.id if actor else None,
            kind=kind,
            body=body,
        )
    )


def _pick_owner(db: Session, org_id: uuid.UUID, settings: CrmSettings) -> uuid.UUID | None:
    """Whose lead a captured enquiry becomes, per the assignment rule."""
    if settings.assignment_rule == "fixed":
        return settings.default_owner_id
    if settings.assignment_rule == "round_robin" and settings.assignment_pool:
        pool = [uuid.UUID(str(x)) for x in settings.assignment_pool]
        # Members can be removed between two captures, so the cursor is taken
        # modulo the *current* pool rather than trusted as an index.
        index = settings.assignment_cursor % len(pool)
        settings.assignment_cursor = (index + 1) % len(pool)
        return pool[index]
    return None


def create_lead(
    db: Session,
    viewer: User,
    payload: S.LeadIn,
    *,
    request: Request | None = None,
) -> S.LeadOut:
    ensure_defaults(db, viewer.org_id)
    status_id = payload.status_id
    if status_id is None:
        fallback = default_status(db, viewer.org_id)
        status_id = fallback.id if fallback else None

    lead = CrmLead(
        org_id=viewer.org_id,
        code=_lead_code(db, viewer.org_id),
        name=payload.name,
        company=payload.company,
        mobile=payload.mobile,
        # "Same number for WhatsApp" is the console's default and the server's
        # too: an empty WhatsApp field on a form that offers to copy the mobile
        # means "yes, the same".
        whatsapp=payload.whatsapp or payload.mobile,
        email=payload.email,
        status_id=status_id,
        source_id=payload.source_id,
        industry_id=payload.industry_id,
        product_id=payload.product_id,
        owner_id=payload.owner_id,
        created_by=viewer.id,
        state_id=payload.state_id,
        city_id=payload.city_id,
        pincode=payload.pincode,
        address=payload.address,
        notes=payload.notes,
        value=payload.value,
    )
    db.add(lead)
    db.flush()
    _log(db, lead, viewer, "note", "Lead created")
    if request is not None:
        audit(db, org_id=viewer.org_id, actor=viewer, action="crm.lead.create", request=request,
              target_type="crm_lead", target_id=str(lead.id), detail={"code": lead.code})
    db.commit()
    db.refresh(lead)
    return _lead_out(lead)


def update_lead(
    db: Session, viewer: User, lead_id: uuid.UUID, payload: S.LeadPatch, *, request: Request | None = None
) -> S.LeadOut:
    lead = _readable_lead(db, viewer, lead_id)
    changes = payload.model_dump(exclude_unset=True)

    if "status_id" in changes and changes["status_id"] != lead.status_id:
        return move_status(
            db, viewer, lead_id,
            S.LeadStatusMove(status_id=changes.pop("status_id"), note=changes.get("lost_reason")),
            extra=changes, request=request,
        )
    if "owner_id" in changes and changes["owner_id"] != lead.owner_id:
        new_owner = db.get(User, changes["owner_id"]) if changes["owner_id"] else None
        _log(db, lead, viewer, "assignment",
             f"Assigned to {new_owner.full_name}" if new_owner else "Returned to the unassigned pool")

    for field, value in changes.items():
        setattr(lead, field, value)
    if request is not None:
        audit(db, org_id=viewer.org_id, actor=viewer, action="crm.lead.update", request=request,
              target_type="crm_lead", target_id=str(lead.id), detail=changes)
    db.commit()
    db.refresh(lead)
    return _lead_out(lead)


def move_status(
    db: Session,
    viewer: User,
    lead_id: uuid.UUID,
    payload: S.LeadStatusMove,
    *,
    extra: dict | None = None,
    request: Request | None = None,
) -> S.LeadOut:
    """Move a lead to a stage, recording it on the timeline.

    The only path that writes ``status_id``, so every stage change is on the
    timeline — including the ones made by dragging a card in Kanban, which is
    where an unlogged change would otherwise come from.
    """
    lead = _readable_lead(db, viewer, lead_id)
    target = get_master(db, viewer.org_id, "statuses", payload.status_id)
    was = lead.status.name if lead.status else "no stage"
    lead.status_id = target.id
    for field, value in (extra or {}).items():
        setattr(lead, field, value)

    behaviour = target.behaviour_enum
    if behaviour is StatusBehaviour.LOST and payload.note:
        lead.lost_reason = payload.note
    body = f"Stage: {was} → {target.name}"
    if payload.note:
        body = f"{body} — {payload.note}"
    _log(db, lead, viewer, "status", body)
    if behaviour.is_terminal:
        # A won or lost lead is out of the pipeline, so any promise to call it
        # back is cancelled with it — otherwise "pending follow-ups" counts work
        # nobody intends to do.
        _cancel_follow_ups(db, lead.id, reason=f"Lead moved to {target.name}")
    _resync_next_follow_up(db, lead.id)
    if request is not None:
        audit(db, org_id=viewer.org_id, actor=viewer, action="crm.lead.status", request=request,
              target_type="crm_lead", target_id=str(lead.id), detail={"status": target.name})
    db.commit()
    db.refresh(lead)
    return _lead_out(lead)


def bulk_assign(
    db: Session, viewer: User, payload: S.LeadBulkAssign, *, request: Request | None = None
) -> int:
    """Hand a batch of leads to one person. Returns how many actually moved."""
    scope = visible_owner_ids(db, viewer)
    stmt = select(CrmLead).where(
        CrmLead.org_id == viewer.org_id, CrmLead.id.in_(payload.lead_ids)
    )
    leads = db.scalars(_scoped(stmt, CrmLead.owner_id, scope)).all()
    owner = db.get(User, payload.owner_id) if payload.owner_id else None
    if payload.owner_id and (owner is None or owner.org_id != viewer.org_id):
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "That person is not in this workspace")

    moved = 0
    for lead in leads:
        if lead.owner_id == payload.owner_id:
            continue
        lead.owner_id = payload.owner_id
        _log(db, lead, viewer, "assignment",
             f"Assigned to {owner.full_name}" if owner else "Returned to the unassigned pool")
        moved += 1
    if request is not None:
        audit(db, org_id=viewer.org_id, actor=viewer, action="crm.lead.bulk_assign",
              request=request,
              detail={"count": moved, "owner": str(payload.owner_id) if payload.owner_id else None})
    db.commit()
    return moved


def delete_lead(db: Session, viewer: User, lead_id: uuid.UUID, *, request: Request | None = None) -> None:
    lead = _readable_lead(db, viewer, lead_id)
    if lead.customer_id:
        raise HTTPException(
            http_status.HTTP_409_CONFLICT,
            detail={
                "reason": "lead_converted",
                "message": (
                    "This lead became a customer. Deleting it would remove the record of "
                    "where that account came from — mark it lost instead if it is a duplicate."
                ),
            },
        )
    if request is not None:
        audit(db, org_id=viewer.org_id, actor=viewer, action="crm.lead.delete", request=request,
              target_type="crm_lead", target_id=str(lead.id), detail={"code": lead.code})
    db.delete(lead)
    db.commit()


def lead_detail(db: Session, viewer: User, lead_id: uuid.UUID) -> S.LeadDetailOut:
    lead = _readable_lead(db, viewer, lead_id)
    follow_ups = db.scalars(
        select(CrmFollowUp)
        .where(CrmFollowUp.lead_id == lead.id)
        .options(selectinload(CrmFollowUp.owner), selectinload(CrmFollowUp.lead))
        .order_by(CrmFollowUp.due_at.desc())
    ).all()
    quotations = db.scalars(
        select(CrmQuotation)
        .where(CrmQuotation.lead_id == lead.id)
        .options(selectinload(CrmQuotation.creator))
        .order_by(CrmQuotation.created_at.desc())
    ).all()
    return S.LeadDetailOut(
        **_lead_out(lead).model_dump(),
        activities=[
            S.ActivityOut(
                id=a.id, kind=a.kind, body=a.body, actor_id=a.actor_id,
                actor_name=a.actor.full_name if a.actor else None, created_at=a.created_at,
            )
            for a in lead.activities
        ],
        follow_ups=[_follow_up_out(f) for f in follow_ups],
        quotations=[_quotation_row_out(q) for q in quotations],
    )


def add_activity(db: Session, viewer: User, lead_id: uuid.UUID, payload: S.ActivityIn) -> S.ActivityOut:
    lead = _readable_lead(db, viewer, lead_id)
    row = CrmActivity(
        org_id=lead.org_id, lead_id=lead.id, actor_id=viewer.id,
        kind=payload.kind, body=payload.body,
    )
    db.add(row)
    if payload.kind == "call":
        lead.last_contacted_at = _now()
    db.commit()
    db.refresh(row)
    return S.ActivityOut(
        id=row.id, kind=row.kind, body=row.body, actor_id=row.actor_id,
        actor_name=viewer.full_name, created_at=row.created_at,
    )


def import_leads(
    db: Session, viewer: User, payload: S.LeadImportIn, *, request: Request | None = None
) -> S.LeadImportResult:
    """Bulk create from a spreadsheet, matching masters by name.

    Unknown sources and industries are created; unknown *statuses* are not. A
    typo in a status column would otherwise invent a pipeline stage that appears
    in the funnel forever, and the sensible fallback — the default stage — is
    both obvious and reversible.
    """
    ensure_defaults(db, viewer.org_id)
    org_id = viewer.org_id
    fallback = default_status(db, org_id)

    def _cache(model: Any) -> dict[str, Any]:
        return {
            row.name.strip().lower(): row
            for row in db.scalars(select(model).where(model.org_id == org_id))
        }

    statuses, sources = _cache(CrmLeadStatus), _cache(CrmLeadSource)
    products, states, cities = _cache(CrmProduct), _cache(CrmState), _cache(CrmCity)

    existing_mobiles: set[str] = set()
    if payload.skip_duplicates:
        existing_mobiles = {
            m for m in db.scalars(select(CrmLead.mobile).where(CrmLead.org_id == org_id))
        }

    created = skipped = 0
    errors: list[str] = []
    for index, row in enumerate(payload.rows, start=1):
        mobile = row.mobile.strip()
        if payload.skip_duplicates and mobile in existing_mobiles:
            skipped += 1
            continue
        source = sources.get((row.source or "").strip().lower())
        if row.source and source is None:
            source = CrmLeadSource(org_id=org_id, name=row.source.strip())
            db.add(source)
            db.flush()
            sources[source.name.lower()] = source
        status = statuses.get((row.status or "").strip().lower()) or fallback
        state = states.get((row.state or "").strip().lower())
        city = cities.get((row.city or "").strip().lower())
        product = products.get((row.product or "").strip().lower())

        try:
            lead = CrmLead(
                org_id=org_id, code=_lead_code(db, org_id), name=row.name.strip(),
                mobile=mobile, whatsapp=mobile, company=row.company, email=row.email,
                status_id=status.id if status else None,
                source_id=source.id if source else None,
                product_id=product.id if product else None,
                state_id=state.id if state else None,
                city_id=city.id if city else None,
                pincode=row.pincode, address=row.address, notes=row.notes,
                owner_id=payload.owner_id, created_by=viewer.id,
            )
            db.add(lead)
            db.flush()
            _log(db, lead, viewer, "note", "Imported from a file")
            existing_mobiles.add(mobile)
            created += 1
        except Exception as exc:  # noqa: BLE001 - one bad row must not lose the batch
            db.rollback()
            errors.append(f"Row {index} ({row.name}): {exc}")

    if request is not None:
        audit(db, org_id=viewer.org_id, actor=viewer, action="crm.lead.import", request=request,
              detail={"created": created, "skipped": skipped, "errors": len(errors)})
    db.commit()
    return S.LeadImportResult(created=created, skipped=skipped, errors=errors)


def capture_lead(db: Session, org: Organization, payload: S.LeadCaptureIn) -> CrmLead:
    """Create a lead from an unauthenticated intake call.

    Called by the public webhook, so it has no ``viewer``: the owner comes from
    the assignment rule and the source from whichever row is marked as the
    intake default. It never raises for a duplicate — a repeated Meta delivery
    is normal and the second one is dropped quietly, because answering an error
    to Meta gets the whole subscription disabled.
    """
    ensure_defaults(db, org.id)
    settings = get_settings(db, org.id)
    mobile = re.sub(r"[^\d+]", "", payload.mobile)

    recent = db.scalar(
        select(CrmLead).where(
            CrmLead.org_id == org.id,
            CrmLead.mobile == mobile,
            CrmLead.created_at >= _now() - timedelta(hours=24),
        )
    )
    if recent is not None:
        _log(db, recent, None, "note", f"Duplicate capture ignored ({payload.campaign or 'intake'})")
        db.commit()
        return recent

    source = db.scalar(
        select(CrmLeadSource).where(
            CrmLeadSource.org_id == org.id, CrmLeadSource.is_intake_default.is_(True)
        )
    )
    status = default_status(db, org.id)
    lead = CrmLead(
        org_id=org.id, code=_lead_code(db, org.id), name=payload.name, mobile=mobile,
        whatsapp=mobile, email=payload.email, company=payload.company,
        status_id=status.id if status else None,
        source_id=source.id if source else None,
        owner_id=_pick_owner(db, org.id, settings),
        notes=payload.notes,
    )
    db.add(lead)
    db.flush()
    _log(db, lead, None, "note", f"Captured from {payload.campaign or 'the intake link'}")
    db.commit()
    db.refresh(lead)
    return lead


# --------------------------------------------------------------------------- #
# Follow-ups
# --------------------------------------------------------------------------- #


def _resync_next_follow_up(db: Session, lead_id: uuid.UUID | None) -> None:
    """Rewrite ``CrmLead.next_follow_up_at`` from the follow-up table.

    The single writer of that column. Called after every create, complete and
    cancel — see rule 2 in the module docstring.
    """
    if lead_id is None:
        return
    lead = db.get(CrmLead, lead_id)
    if lead is None:
        return
    lead.next_follow_up_at = db.scalar(
        select(func.min(CrmFollowUp.due_at)).where(
            CrmFollowUp.lead_id == lead_id,
            CrmFollowUp.status == FollowUpStatus.PENDING.value,
        )
    )


def _cancel_follow_ups(db: Session, lead_id: uuid.UUID, *, reason: str) -> None:
    rows = db.scalars(
        select(CrmFollowUp).where(
            CrmFollowUp.lead_id == lead_id, CrmFollowUp.status == FollowUpStatus.PENDING.value
        )
    ).all()
    for row in rows:
        row.status = FollowUpStatus.CANCELLED.value
        row.outcome = reason
        row.completed_at = _now()
    # Flushed here rather than left to the caller: the session runs with
    # autoflush off, so `_resync_next_follow_up` — which every caller runs
    # straight after this — would query the database and still see these rows as
    # pending, leaving a cancelled follow-up on a won lead's "next" column.
    db.flush()


def list_follow_ups(
    db: Session,
    viewer: User,
    *,
    status: str | None = "pending",
    window: str | None = None,
    owner_id: uuid.UUID | None = None,
    q: str | None = None,
) -> list[S.FollowUpOut]:
    scope = visible_owner_ids(db, viewer)
    stmt = (
        select(CrmFollowUp)
        .where(CrmFollowUp.org_id == viewer.org_id)
        .options(
            selectinload(CrmFollowUp.lead),
            selectinload(CrmFollowUp.customer),
            selectinload(CrmFollowUp.owner),
        )
    )
    stmt = _scoped(stmt, CrmFollowUp.owner_id, scope)
    if status:
        stmt = stmt.where(CrmFollowUp.status == status)
    if owner_id:
        stmt = stmt.where(CrmFollowUp.owner_id == owner_id)

    now = _now()
    if window == "today":
        stmt = stmt.where(
            CrmFollowUp.due_at.between(
                datetime.combine(now.date(), time.min, timezone.utc),
                datetime.combine(now.date(), time.max, timezone.utc),
            )
        )
    elif window == "overdue":
        stmt = stmt.where(CrmFollowUp.due_at < now)
    elif window == "upcoming":
        stmt = stmt.where(CrmFollowUp.due_at >= now)
    elif window == "week":
        stmt = stmt.where(
            CrmFollowUp.due_at <= datetime.combine(now.date() + timedelta(days=7), time.max, timezone.utc)
        )

    rows = db.scalars(stmt.order_by(CrmFollowUp.due_at)).all()
    out = [_follow_up_out(row) for row in rows]
    if q:
        needle = q.strip().lower()
        out = [
            row for row in out
            if needle in (row.subject_name or "").lower()
            or needle in (row.subject_mobile or "")
            or needle in (row.purpose or "").lower()
        ]
    return out


def create_follow_up(db: Session, viewer: User, payload: S.FollowUpIn) -> S.FollowUpOut:
    if not payload.lead_id and not payload.customer_id:
        raise HTTPException(
            http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "reason": "no_subject",
                "message": "A follow-up has to be against a lead or a customer.",
            },
        )
    owner_id = payload.owner_id
    if payload.lead_id:
        lead = _readable_lead(db, viewer, payload.lead_id)
        owner_id = owner_id or lead.owner_id or viewer.id
    else:
        customer = _readable_customer(db, viewer, payload.customer_id)  # type: ignore[arg-type]
        owner_id = owner_id or customer.manager_id or viewer.id

    row = CrmFollowUp(
        org_id=viewer.org_id, lead_id=payload.lead_id, customer_id=payload.customer_id,
        owner_id=owner_id, due_at=payload.due_at, purpose=payload.purpose, notes=payload.notes,
    )
    db.add(row)
    db.flush()
    if payload.lead_id:
        lead = db.get(CrmLead, payload.lead_id)
        if lead is not None:
            _log(db, lead, viewer, "followup",
                 f"Follow-up booked for {payload.due_at:%d %b %Y %H:%M}"
                 + (f" — {payload.purpose}" if payload.purpose else ""))
        _resync_next_follow_up(db, payload.lead_id)
    db.commit()
    db.refresh(row)
    return _follow_up_out(row)


def complete_follow_up(
    db: Session, viewer: User, follow_up_id: uuid.UUID, payload: S.FollowUpComplete
) -> S.FollowUpOut:
    """Close a follow-up, and optionally book the next one and move the stage.

    All three in one call because they are one action to the person doing it —
    they have just put the phone down — and three requests is three chances for
    the second to fail after the first succeeded.
    """
    row = db.get(CrmFollowUp, follow_up_id)
    if row is None or row.org_id != viewer.org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Follow-up not found")
    scope = visible_owner_ids(db, viewer)
    if scope is not None and row.owner_id is not None and row.owner_id not in scope:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Follow-up not found")

    row.status = FollowUpStatus.DONE.value
    row.outcome = payload.outcome
    row.completed_at = _now()

    lead = db.get(CrmLead, row.lead_id) if row.lead_id else None
    if lead is not None:
        lead.last_contacted_at = row.completed_at
        _log(db, lead, viewer, "followup",
             f"Follow-up completed{': ' + payload.outcome if payload.outcome else ''}")

    if payload.next_due_at:
        db.add(CrmFollowUp(
            org_id=viewer.org_id, lead_id=row.lead_id, customer_id=row.customer_id,
            owner_id=row.owner_id, due_at=payload.next_due_at, purpose=payload.next_purpose,
        ))
    if payload.status_id and lead is not None:
        target = get_master(db, viewer.org_id, "statuses", payload.status_id)
        was = lead.status.name if lead.status else "no stage"
        lead.status_id = target.id
        _log(db, lead, viewer, "status", f"Stage: {was} → {target.name}")
        if target.behaviour_enum.is_terminal:
            _cancel_follow_ups(db, lead.id, reason=f"Lead moved to {target.name}")

    db.flush()
    _resync_next_follow_up(db, row.lead_id)
    db.commit()
    db.refresh(row)
    return _follow_up_out(row)


def cancel_follow_up(db: Session, viewer: User, follow_up_id: uuid.UUID) -> None:
    row = db.get(CrmFollowUp, follow_up_id)
    if row is None or row.org_id != viewer.org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Follow-up not found")
    row.status = FollowUpStatus.CANCELLED.value
    row.completed_at = _now()
    db.flush()
    _resync_next_follow_up(db, row.lead_id)
    db.commit()


# --------------------------------------------------------------------------- #
# Customers
# --------------------------------------------------------------------------- #

_CUSTOMER_LOADERS = (
    selectinload(CrmCustomer.industry),
    selectinload(CrmCustomer.state),
    selectinload(CrmCustomer.city),
    selectinload(CrmCustomer.manager),
    selectinload(CrmCustomer.plans),
)


def _readable_customer(db: Session, viewer: User, customer_id: uuid.UUID) -> CrmCustomer:
    row = db.get(CrmCustomer, customer_id)
    if row is None or row.org_id != viewer.org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Customer not found")
    scope = visible_owner_ids(db, viewer)
    if scope is not None and row.manager_id is not None and row.manager_id not in scope:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Customer not found")
    return row


def _customer_code(db: Session, org_id: uuid.UUID) -> str:
    number = next_number(db, org_id, "customer")
    return f"{number:05d}"


def list_customers(
    db: Session,
    viewer: User,
    *,
    q: str | None = None,
    status: str | None = None,
    manager_id: uuid.UUID | None = None,
    renewal: str | None = None,
) -> list[S.CustomerOut]:
    scope = visible_owner_ids(db, viewer)
    stmt = (
        select(CrmCustomer)
        .where(CrmCustomer.org_id == viewer.org_id)
        .options(*_CUSTOMER_LOADERS)
    )
    stmt = _scoped(stmt, CrmCustomer.manager_id, scope)
    if status:
        stmt = stmt.where(CrmCustomer.status == status)
    if manager_id:
        stmt = stmt.where(CrmCustomer.manager_id == manager_id)
    if q:
        needle = f"%{q.strip().lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(CrmCustomer.name).like(needle),
                func.lower(func.coalesce(CrmCustomer.company, "")).like(needle),
                CrmCustomer.mobile.like(needle),
                func.lower(func.coalesce(CrmCustomer.email, "")).like(needle),
                func.lower(CrmCustomer.code).like(needle),
            )
        )

    rows = [_customer_out(row) for row in db.scalars(stmt.order_by(CrmCustomer.created_at.desc()))]
    if renewal == "due":
        window = get_settings(db, viewer.org_id).renewal_window_days
        rows = [
            row for row in rows
            if row.primary_plan and row.primary_plan.days_to_renewal is not None
            and 0 <= row.primary_plan.days_to_renewal <= window
        ]
    elif renewal == "expired":
        rows = [
            row for row in rows
            if row.primary_plan and row.primary_plan.days_to_renewal is not None
            and row.primary_plan.days_to_renewal < 0
        ]
    return rows


def create_customer(
    db: Session, viewer: User, payload: S.CustomerIn, *, request: Request | None = None
) -> S.CustomerOut:
    ensure_defaults(db, viewer.org_id)
    code = payload.code or _customer_code(db, viewer.org_id)
    if db.scalar(select(CrmCustomer.id).where(
        CrmCustomer.org_id == viewer.org_id, CrmCustomer.code == code
    )):
        raise HTTPException(
            http_status.HTTP_409_CONFLICT,
            detail={"reason": "duplicate_code", "message": f"Customer ID {code} is already in use."},
        )
    row = CrmCustomer(
        org_id=viewer.org_id, code=code, name=payload.name, company=payload.company,
        mobile=payload.mobile, whatsapp=payload.whatsapp or payload.mobile, email=payload.email,
        customer_type=payload.customer_type, industry_id=payload.industry_id,
        source_id=payload.source_id, gstin=payload.gstin, country_id=payload.country_id,
        state_id=payload.state_id, city_id=payload.city_id, pincode=payload.pincode,
        address=payload.address, manager_id=payload.manager_id or viewer.id,
        status=payload.status or CustomerStatus.ACTIVE.value, notes=payload.notes,
    )
    db.add(row)
    if request is not None:
        audit(db, org_id=viewer.org_id, actor=viewer, action="crm.customer.create",
              request=request, target_type="crm_customer", target_id=str(row.id),
              detail={"code": code})
    db.commit()
    db.refresh(row)
    return _customer_out(row)


def update_customer(
    db: Session, viewer: User, customer_id: uuid.UUID, payload: S.CustomerPatch
) -> S.CustomerOut:
    row = _readable_customer(db, viewer, customer_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return _customer_out(row)


def customer_detail(db: Session, viewer: User, customer_id: uuid.UUID) -> S.CustomerDetailOut:
    row = _readable_customer(db, viewer, customer_id)
    interactions = db.scalars(
        select(CrmInteraction)
        .where(CrmInteraction.customer_id == row.id)
        .options(
            selectinload(CrmInteraction.staff),
            selectinload(CrmInteraction.customer),
            selectinload(CrmInteraction.follow_up),
        )
        .order_by(CrmInteraction.created_at.desc())
        .limit(50)
    ).all()
    visits = db.scalars(
        select(CrmVisit)
        .where(CrmVisit.customer_id == row.id)
        .options(
            selectinload(CrmVisit.customer),
            selectinload(CrmVisit.employee),
            selectinload(CrmVisit.visit_type),
        )
        .order_by(CrmVisit.scheduled_at.desc())
        .limit(50)
    ).all()
    return S.CustomerDetailOut(
        **_customer_out(row).model_dump(),
        plans=[_plan_out(p) for p in sorted(row.plans, key=lambda p: p.start_on, reverse=True)],
        interactions=[_interaction_out(i) for i in interactions],
        visits=[_visit_out(v) for v in visits],
    )


def _plan_defaults(db: Session, org_id: uuid.UUID, payload: S.CustomerPlanIn) -> tuple[str, str | None, date | None]:
    """Resolve a plan line's snapshot names and its end date.

    ``end_on`` is computed from the plan's duration when the caller did not
    give one, which is what makes "sold a 12-month licence today" a two-field
    entry rather than a date-arithmetic exercise.
    """
    product = db.get(CrmProduct, payload.product_id) if payload.product_id else None
    plan = db.get(CrmPlan, payload.plan_id) if payload.plan_id else None
    if product is not None and product.org_id != org_id:
        product = None
    if plan is not None and plan.org_id != org_id:
        plan = None

    name = payload.product_name or (product.name if product else None)
    if not name:
        raise HTTPException(
            http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"reason": "no_product", "message": "Say what the customer bought."},
        )
    end_on = payload.end_on
    if end_on is None and plan is not None and plan.duration_days:
        end_on = payload.start_on + timedelta(days=plan.duration_days)
    return name, payload.plan_name or (plan.name if plan else None), end_on


def add_plan(
    db: Session, viewer: User, customer_id: uuid.UUID, payload: S.CustomerPlanIn
) -> S.CustomerPlanOut:
    customer = _readable_customer(db, viewer, customer_id)
    product_name, plan_name, end_on = _plan_defaults(db, viewer.org_id, payload)
    row = CrmCustomerPlan(
        org_id=viewer.org_id, customer_id=customer.id, product_id=payload.product_id,
        plan_id=payload.plan_id, product_name=product_name, plan_name=plan_name,
        start_on=payload.start_on, end_on=end_on,
        # Defaulted to the end date: a renewal conversation that is not
        # scheduled is a renewal that gets noticed after it lapses.
        renewal_on=payload.renewal_on or end_on,
        amount=_money(payload.amount), payment_status=payload.payment_status,
        status=payload.status, notes=payload.notes,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _plan_out(row)


def update_plan(
    db: Session, viewer: User, plan_row_id: uuid.UUID, payload: S.CustomerPlanIn
) -> S.CustomerPlanOut:
    row = db.get(CrmCustomerPlan, plan_row_id)
    if row is None or row.org_id != viewer.org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Plan not found")
    _readable_customer(db, viewer, row.customer_id)
    product_name, plan_name, end_on = _plan_defaults(db, viewer.org_id, payload)
    row.product_id = payload.product_id
    row.plan_id = payload.plan_id
    row.product_name = product_name
    row.plan_name = plan_name
    row.start_on = payload.start_on
    row.end_on = end_on
    row.renewal_on = payload.renewal_on or end_on
    row.amount = _money(payload.amount)
    row.payment_status = payload.payment_status
    row.status = payload.status
    row.notes = payload.notes
    db.commit()
    db.refresh(row)
    return _plan_out(row)


def delete_plan(db: Session, viewer: User, plan_row_id: uuid.UUID) -> None:
    row = db.get(CrmCustomerPlan, plan_row_id)
    if row is None or row.org_id != viewer.org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Plan not found")
    _readable_customer(db, viewer, row.customer_id)
    db.delete(row)
    db.commit()


def convert_lead(
    db: Session,
    viewer: User,
    lead_id: uuid.UUID,
    payload: S.ConvertLeadIn,
    *,
    request: Request | None = None,
) -> S.CustomerOut:
    """Turn a lead into a customer, once.

    Copies forward; the customer keeps a plain id back to the lead with no
    foreign key (see the model docstring). A second attempt is refused rather
    than creating a second account for the same person — the usual cause is a
    double-click, and the usual consequence of allowing it is two support
    histories for one customer.
    """
    lead = _readable_lead(db, viewer, lead_id)
    if lead.customer_id:
        raise HTTPException(
            http_status.HTTP_409_CONFLICT,
            detail={
                "reason": "already_converted",
                "message": "This lead has already become a customer.",
            },
        )

    code = payload.code or _customer_code(db, viewer.org_id)
    customer = CrmCustomer(
        org_id=viewer.org_id, code=code, name=lead.name, company=lead.company,
        mobile=lead.mobile, whatsapp=lead.whatsapp or lead.mobile, email=lead.email,
        customer_type=payload.customer_type, industry_id=lead.industry_id,
        source_id=lead.source_id, gstin=payload.gstin,
        state_id=lead.state_id, city_id=lead.city_id, pincode=lead.pincode,
        address=lead.address, manager_id=payload.manager_id or lead.owner_id or viewer.id,
        status=CustomerStatus.ACTIVE.value, converted_from_lead_id=lead.id,
    )
    db.add(customer)
    db.flush()

    if payload.plan is not None:
        product_name, plan_name, end_on = _plan_defaults(db, viewer.org_id, payload.plan)
        db.add(CrmCustomerPlan(
            org_id=viewer.org_id, customer_id=customer.id,
            product_id=payload.plan.product_id, plan_id=payload.plan.plan_id,
            product_name=product_name, plan_name=plan_name,
            start_on=payload.plan.start_on, end_on=end_on,
            renewal_on=payload.plan.renewal_on or end_on,
            amount=_money(payload.plan.amount), payment_status=payload.plan.payment_status,
            status=payload.plan.status, notes=payload.plan.notes,
        ))

    lead.customer_id = customer.id
    lead.converted_at = _now()
    won = db.scalar(
        select(CrmLeadStatus).where(
            CrmLeadStatus.org_id == viewer.org_id,
            CrmLeadStatus.behaviour == StatusBehaviour.WON.value,
        )
    )
    if won is not None:
        lead.status_id = won.id
    _log(db, lead, viewer, "converted", f"Converted to customer {code}")
    _cancel_follow_ups(db, lead.id, reason="Lead converted")
    db.flush()
    _resync_next_follow_up(db, lead.id)
    if request is not None:
        audit(db, org_id=viewer.org_id, actor=viewer, action="crm.lead.convert", request=request,
              target_type="crm_lead", target_id=str(lead.id),
              detail={"customer": str(customer.id), "code": code})
    db.commit()
    db.refresh(customer)
    return _customer_out(customer)


# --------------------------------------------------------------------------- #
# Support desk
# --------------------------------------------------------------------------- #


def list_interactions(
    db: Session,
    viewer: User,
    *,
    customer_id: uuid.UUID | None = None,
    status: str | None = None,
    limit: int = 100,
) -> list[S.InteractionOut]:
    stmt = (
        select(CrmInteraction)
        .where(CrmInteraction.org_id == viewer.org_id)
        .options(
            selectinload(CrmInteraction.customer),
            selectinload(CrmInteraction.staff),
            selectinload(CrmInteraction.follow_up),
        )
    )
    if customer_id:
        stmt = stmt.where(CrmInteraction.customer_id == customer_id)
    if status:
        stmt = stmt.where(CrmInteraction.status == status)
    rows = db.scalars(stmt.order_by(CrmInteraction.created_at.desc()).limit(limit)).all()
    return [_interaction_out(row) for row in rows]


def log_interaction(db: Session, viewer: User, payload: S.InteractionIn) -> S.InteractionOut:
    customer = _readable_customer(db, viewer, payload.customer_id)
    settings = get_settings(db, viewer.org_id)
    number = next_number(db, viewer.org_id, "ticket")
    disposition = (
        get_master(db, viewer.org_id, "dispositions", payload.disposition_id)
        if payload.disposition_id else None
    )

    status = payload.status
    # A disposition that means "done" closes the call unless the caller has
    # explicitly said otherwise. The desk's status dropdown still wins — this is
    # a default, not an override.
    if disposition is not None and disposition.closes_interaction and payload.status == "open":
        status = InteractionStatus.CLOSED.value

    row = CrmInteraction(
        org_id=viewer.org_id,
        ticket_no=f"{settings.ticket_prefix}-{number:05d}",
        customer_id=customer.id,
        direction=payload.direction,
        disposition_id=disposition.id if disposition else None,
        # Snapshotted: a renamed disposition must not rewrite what last year's
        # calls were about.
        disposition_name=disposition.name if disposition else None,
        status=status,
        remarks=payload.remarks,
        staff_id=viewer.id,
        closed_at=_now() if status == InteractionStatus.CLOSED.value else None,
    )
    db.add(row)
    db.flush()

    if payload.follow_up_at:
        follow_up = CrmFollowUp(
            org_id=viewer.org_id, customer_id=customer.id,
            owner_id=customer.manager_id or viewer.id, due_at=payload.follow_up_at,
            purpose=payload.follow_up_purpose or "Support call-back",
        )
        db.add(follow_up)
        db.flush()
        row.follow_up_id = follow_up.id

    db.commit()
    db.refresh(row)
    return _interaction_out(row)


def close_interaction(db: Session, viewer: User, interaction_id: uuid.UUID) -> S.InteractionOut:
    row = db.get(CrmInteraction, interaction_id)
    if row is None or row.org_id != viewer.org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Interaction not found")
    row.status = InteractionStatus.CLOSED.value
    row.closed_at = _now()
    db.commit()
    db.refresh(row)
    return _interaction_out(row)


def support_summary(db: Session, viewer: User) -> S.SupportSummary:
    org = viewer.org_id
    today_start = datetime.combine(date.today(), time.min, timezone.utc)
    count = lambda stmt: db.scalar(select(func.count()).select_from(stmt.subquery())) or 0  # noqa: E731
    base = select(CrmInteraction.id).where(CrmInteraction.org_id == org)
    return S.SupportSummary(
        logged_today=count(base.where(CrmInteraction.created_at >= today_start)),
        open=count(base.where(CrmInteraction.status == InteractionStatus.OPEN.value)),
        closed=count(base.where(CrmInteraction.status == InteractionStatus.CLOSED.value)),
    )


# --------------------------------------------------------------------------- #
# Visits
# --------------------------------------------------------------------------- #

_VISIT_LOADERS = (
    selectinload(CrmVisit.customer),
    selectinload(CrmVisit.employee),
    selectinload(CrmVisit.visit_type),
)


def _readable_visit(db: Session, viewer: User, visit_id: uuid.UUID) -> CrmVisit:
    row = db.get(CrmVisit, visit_id)
    if row is None or row.org_id != viewer.org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Visit not found")
    scope = visible_owner_ids(db, viewer)
    if scope is not None and row.assigned_to is not None and row.assigned_to not in scope:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Visit not found")
    return row


def list_visits(
    db: Session,
    viewer: User,
    *,
    q: str | None = None,
    status: str | None = None,
    visit_type_id: uuid.UUID | None = None,
    employee_id: uuid.UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> list[S.VisitOut]:
    scope = visible_owner_ids(db, viewer)
    stmt = select(CrmVisit).where(CrmVisit.org_id == viewer.org_id).options(*_VISIT_LOADERS)
    stmt = _scoped(stmt, CrmVisit.assigned_to, scope)
    if status:
        stmt = stmt.where(CrmVisit.status == status)
    if visit_type_id:
        stmt = stmt.where(CrmVisit.visit_type_id == visit_type_id)
    if employee_id:
        stmt = stmt.where(CrmVisit.assigned_to == employee_id)
    if date_from:
        stmt = stmt.where(CrmVisit.scheduled_at >= datetime.combine(date_from, time.min, timezone.utc))
    if date_to:
        stmt = stmt.where(CrmVisit.scheduled_at <= datetime.combine(date_to, time.max, timezone.utc))

    rows = [_visit_out(row) for row in db.scalars(stmt.order_by(CrmVisit.scheduled_at.desc()))]
    if q:
        needle = q.strip().lower()
        rows = [
            row for row in rows
            if needle in row.visit_no.lower()
            or needle in (row.customer_name or "").lower()
            or needle in (row.mobile or "")
            or needle in (row.customer_mobile or "")
            or needle in (row.purpose or "").lower()
        ]
    return rows


def visit_summary(db: Session, viewer: User) -> S.VisitSummary:
    rows = list_visits(db, viewer)
    now = _now()
    today = now.date()
    return S.VisitSummary(
        today=sum(1 for r in rows if _aware(r.scheduled_at).date() == today),
        pending=sum(1 for r in rows if r.status == VisitStatus.SCHEDULED.value),
        in_progress=sum(1 for r in rows if r.status == VisitStatus.IN_PROGRESS.value),
        completed=sum(1 for r in rows if r.status == VisitStatus.COMPLETED.value),
        # Overdue means scheduled, in the past, and still not started — a visit
        # in progress is late but being dealt with, which is not the same thing.
        overdue=sum(
            1 for r in rows
            if r.status == VisitStatus.SCHEDULED.value and _aware(r.scheduled_at) < now
        ),
        cancelled=sum(1 for r in rows if r.status == VisitStatus.CANCELLED.value),
    )


def create_visit(db: Session, viewer: User, payload: S.VisitIn) -> S.VisitOut:
    ensure_defaults(db, viewer.org_id)
    customer = _readable_customer(db, viewer, payload.customer_id)
    settings = get_settings(db, viewer.org_id)
    visit_type = (
        get_master(db, viewer.org_id, "visit-types", payload.visit_type_id)
        if payload.visit_type_id else None
    )
    number = next_number(db, viewer.org_id, "visit")
    row = CrmVisit(
        org_id=viewer.org_id,
        visit_no=f"{settings.visit_prefix}-{number:04d}",
        customer_id=customer.id,
        visit_type_id=visit_type.id if visit_type else None,
        visit_type_name=visit_type.name if visit_type else None,
        contact_person=payload.contact_person,
        mobile=payload.mobile or customer.mobile,
        address=payload.address,
        priority=payload.priority,
        purpose=payload.purpose,
        notes=payload.notes,
        assigned_to=payload.assigned_to,
        created_by=viewer.id,
        scheduled_at=payload.scheduled_at,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _visit_out(row)


def update_visit(db: Session, viewer: User, visit_id: uuid.UUID, payload: S.VisitPatch) -> S.VisitOut:
    row = _readable_visit(db, viewer, visit_id)
    changes = payload.model_dump(exclude_unset=True)
    if "visit_type_id" in changes:
        visit_type = (
            get_master(db, viewer.org_id, "visit-types", changes["visit_type_id"])
            if changes["visit_type_id"] else None
        )
        row.visit_type_name = visit_type.name if visit_type else None
    for field, value in changes.items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return _visit_out(row)


def issue_visit_otp(db: Session, viewer: User, visit_id: uuid.UUID) -> str:
    """Mint the arrival code for a visit.

    Returned to the caller rather than delivered: this product has no SMS
    channel of its own, so the console shows the code to whoever is dispatching
    and they send it however they already talk to the customer. Saying so out
    loud beats a function named ``send_otp`` that quietly does not send.
    """
    row = _readable_visit(db, viewer, visit_id)
    code = f"{secrets.randbelow(1_000_000):06d}"
    row.otp_code = code
    row.otp_verified_at = None
    db.commit()
    return code


def start_visit(db: Session, viewer: User, visit_id: uuid.UUID, payload: S.VisitCheckIn) -> S.VisitOut:
    row = _readable_visit(db, viewer, visit_id)
    needs_otp = bool(row.visit_type and row.visit_type.requires_otp)
    if needs_otp:
        if not row.otp_code:
            raise HTTPException(
                http_status.HTTP_409_CONFLICT,
                detail={
                    "reason": "otp_not_issued",
                    "message": "Send the customer their arrival code before checking in.",
                },
            )
        if not payload.otp or not secrets.compare_digest(payload.otp.strip(), row.otp_code):
            raise HTTPException(
                http_status.HTTP_403_FORBIDDEN,
                detail={"reason": "otp_mismatch", "message": "That code does not match."},
            )
        row.otp_verified_at = _now()
        # Cleared so the same code cannot be replayed on the next visit.
        row.otp_code = None

    row.status = VisitStatus.IN_PROGRESS.value
    row.started_at = _now()
    db.commit()
    db.refresh(row)
    return _visit_out(row)


def close_visit(db: Session, viewer: User, visit_id: uuid.UUID, payload: S.VisitCloseIn) -> S.VisitOut:
    row = _readable_visit(db, viewer, visit_id)
    now = _now()
    row.status = VisitStatus.COMPLETED.value
    row.completed_at = now
    # A visit closed without ever being checked in still took time; dating the
    # start from the schedule keeps the duration column honest rather than empty.
    row.started_at = row.started_at or _aware(row.scheduled_at)
    row.outcome = payload.outcome
    if payload.next_follow_up_at:
        db.add(CrmFollowUp(
            org_id=viewer.org_id, customer_id=row.customer_id,
            owner_id=row.assigned_to or viewer.id, due_at=payload.next_follow_up_at,
            purpose=f"After visit {row.visit_no}",
        ))
    db.commit()
    db.refresh(row)
    return _visit_out(row)


def cancel_visit(db: Session, viewer: User, visit_id: uuid.UUID) -> S.VisitOut:
    row = _readable_visit(db, viewer, visit_id)
    row.status = VisitStatus.CANCELLED.value
    db.commit()
    db.refresh(row)
    return _visit_out(row)


# --------------------------------------------------------------------------- #
# Quotations
# --------------------------------------------------------------------------- #


def _company_state(db: Session, org_id: uuid.UUID) -> str | None:
    org = db.get(Organization, org_id)
    return (org.state or "").strip().lower() or None if org else None


def _price_lines(
    lines: Sequence[S.QuotationLineIn], *, interstate: bool
) -> tuple[list[dict], dict[str, Decimal]]:
    """Price a quotation. The one place the arithmetic happens.

    Per line: gross = qty × rate, less the discount (a percentage or an amount),
    then GST on what is left. Totals are summed from the **rounded per-line**
    figures rather than rounded once at the end, because that is what a printed
    document shows — a total that does not equal the visible column is the first
    thing a customer queries.

    CGST/SGST against IGST is decided once, by ``interstate``, and applied to
    every line: a single document cannot be half intra-state.
    """
    priced: list[dict] = []
    sub_total = discount_total = taxable = tax_total = Decimal("0")

    for order, line in enumerate(lines):
        quantity = Decimal(line.quantity).quantize(QTY, rounding=ROUND_HALF_UP)
        gross = _money(quantity * Decimal(line.rate))
        if line.discount_is_percent:
            discount = _money(gross * Decimal(line.discount) / Decimal("100"))
        else:
            discount = _money(line.discount)
        # A discount larger than the line is a typo, not a credit note. Clamp
        # rather than reject: refusing the keystroke mid-edit is how a builder
        # becomes unusable, and a negative taxable value would be a tax return
        # nobody can file.
        discount = min(discount, gross)
        line_taxable = _money(gross - discount)
        tax = _money(line_taxable * Decimal(line.gst_percent) / Decimal("100"))

        priced.append({
            "product_id": line.product_id,
            "plan_id": line.plan_id,
            "name": line.name,
            "description": line.description,
            "hsn_sac": line.hsn_sac,
            "quantity": quantity,
            "rate": _money(line.rate),
            "discount": Decimal(line.discount),
            "discount_is_percent": line.discount_is_percent,
            "gst_percent": Decimal(line.gst_percent),
            "taxable_value": line_taxable,
            "tax_amount": tax,
            "amount": _money(line_taxable + tax),
            "sort_order": order,
        })
        sub_total += gross
        discount_total += discount
        taxable += line_taxable
        tax_total += tax

    half = _money(tax_total / 2)
    totals = {
        "sub_total": _money(sub_total),
        "discount_total": _money(discount_total),
        "taxable_value": _money(taxable),
        "cgst": Decimal("0") if interstate else half,
        # The second half takes the remainder, so CGST + SGST is always exactly
        # the tax charged even when the halving does not divide evenly.
        "sgst": Decimal("0") if interstate else _money(tax_total - half),
        "igst": _money(tax_total) if interstate else Decimal("0"),
        "grand_total": _money(taxable + tax_total),
    }
    return priced, totals


def list_quotations(
    db: Session, viewer: User, *, status: str | None = None, q: str | None = None
) -> list[S.QuotationRowOut]:
    scope = visible_owner_ids(db, viewer)
    stmt = (
        select(CrmQuotation)
        .where(CrmQuotation.org_id == viewer.org_id)
        .options(selectinload(CrmQuotation.creator))
    )
    stmt = _scoped(stmt, CrmQuotation.created_by, scope)
    if status:
        stmt = stmt.where(CrmQuotation.status == status)
    if q:
        needle = f"%{q.strip().lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(CrmQuotation.number).like(needle),
                func.lower(func.coalesce(CrmQuotation.customer_name, "")).like(needle),
                func.lower(func.coalesce(CrmQuotation.company, "")).like(needle),
            )
        )
    return [
        _quotation_row_out(row)
        for row in db.scalars(stmt.order_by(CrmQuotation.created_at.desc()))
    ]


def quotation_summary(db: Session, viewer: User) -> S.QuotationSummary:
    rows = list_quotations(db, viewer)
    today = date.today()
    return S.QuotationSummary(
        count=len(rows),
        open_value=_money(sum(
            (r.grand_total for r in rows if QuotationStatus(r.status).is_open), Decimal("0")
        )),
        accepted_value=_money(sum(
            (r.grand_total for r in rows if r.status == QuotationStatus.ACCEPTED.value),
            Decimal("0"),
        )),
        # Counted from the date rather than the stored status: nothing sweeps
        # quotations into `expired`, so a status-only count would read zero
        # forever on a workspace with a shelf full of stale offers.
        expired=sum(
            1 for r in rows
            if r.valid_until and r.valid_until < today and QuotationStatus(r.status).is_open
        ),
    )


def get_quotation(db: Session, viewer: User, quotation_id: uuid.UUID) -> S.QuotationOut:
    row = _readable_quotation(db, viewer, quotation_id)
    return _quotation_out(row)


def _readable_quotation(db: Session, viewer: User, quotation_id: uuid.UUID) -> CrmQuotation:
    row = db.get(CrmQuotation, quotation_id)
    if row is None or row.org_id != viewer.org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Quotation not found")
    scope = visible_owner_ids(db, viewer)
    if scope is not None and row.created_by is not None and row.created_by not in scope:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Quotation not found")
    return row


def _apply_quotation(
    db: Session, viewer: User, row: CrmQuotation, payload: S.QuotationIn
) -> None:
    """Write a payload onto a quotation and reprice it."""
    settings = get_settings(db, viewer.org_id)
    for field in (
        "lead_id", "customer_id", "customer_name", "company", "gstin", "mobile", "whatsapp",
        "email", "city", "state", "pincode", "billing_address", "shipping_address", "notes",
    ):
        setattr(row, field, getattr(payload, field))
    row.quote_date = payload.quote_date
    row.valid_until = payload.valid_until or (
        payload.quote_date + timedelta(days=settings.quotation_validity_days)
    )
    row.terms = payload.terms if payload.terms is not None else settings.quotation_terms

    home = _company_state(db, viewer.org_id)
    place = (payload.state or "").strip().lower() or None
    # Unknown place of supply is treated as intra-state — the same state as the
    # company — because that is the overwhelmingly common case and the one an
    # unfilled form implies. It is on the document as `is_interstate` either way,
    # so a wrong guess is visible rather than buried.
    row.is_interstate = bool(home and place and home != place)

    priced, totals = _price_lines(payload.lines, interstate=row.is_interstate)
    for key, value in totals.items():
        setattr(row, key, value)

    # Replace the whole set. A quotation is edited as a document, and diffing
    # lines by id would need ids the console does not have for rows the user has
    # just typed.
    db.execute(delete(CrmQuotationLine).where(CrmQuotationLine.quotation_id == row.id))
    for line in priced:
        db.add(CrmQuotationLine(org_id=viewer.org_id, quotation_id=row.id, **line))


def create_quotation(
    db: Session, viewer: User, payload: S.QuotationIn, *, request: Request | None = None
) -> S.QuotationOut:
    settings = get_settings(db, viewer.org_id)
    year = str(payload.quote_date.year)
    number = next_number(db, viewer.org_id, "quotation", period=year)
    row = CrmQuotation(
        org_id=viewer.org_id,
        number=f"{settings.quotation_prefix}-{year}-{number:04d}",
        quote_date=payload.quote_date,
        created_by=viewer.id,
    )
    db.add(row)
    db.flush()
    _apply_quotation(db, viewer, row, payload)

    if payload.lead_id:
        lead = db.get(CrmLead, payload.lead_id)
        if lead is not None and lead.org_id == viewer.org_id:
            _log(db, lead, viewer, "quotation", f"Quotation {row.number} raised")

    try:
        db.commit()
    except IntegrityError:
        # Two people saved a first draft in the same second. The counter is not
        # locked (see `next_number`), so the loser retries with a fresh number
        # rather than being shown a constraint name.
        db.rollback()
        raise HTTPException(
            http_status.HTTP_409_CONFLICT,
            detail={
                "reason": "number_taken",
                "message": "Somebody else took that quotation number. Save again.",
            },
        ) from None
    db.refresh(row)
    if request is not None:
        audit(db, org_id=viewer.org_id, actor=viewer, action="crm.quotation.create",
              request=request, target_type="crm_quotation", target_id=str(row.id),
              detail={"number": row.number})
    return _quotation_out(row)


def update_quotation(
    db: Session, viewer: User, quotation_id: uuid.UUID, payload: S.QuotationIn
) -> S.QuotationOut:
    row = _readable_quotation(db, viewer, quotation_id)
    if row.status_enum in (QuotationStatus.ACCEPTED, QuotationStatus.REJECTED):
        raise HTTPException(
            http_status.HTTP_409_CONFLICT,
            detail={
                "reason": "quotation_decided",
                "message": (
                    "This quotation has been answered. Raise a revision rather than "
                    "editing what the customer replied to."
                ),
            },
        )
    _apply_quotation(db, viewer, row, payload)
    db.commit()
    db.refresh(row)
    return _quotation_out(row)


def set_quotation_status(
    db: Session, viewer: User, quotation_id: uuid.UUID, payload: S.QuotationStatusIn
) -> S.QuotationOut:
    row = _readable_quotation(db, viewer, quotation_id)
    row.status = payload.status
    now = _now()
    if payload.status == QuotationStatus.SENT.value:
        row.sent_at = now
    if payload.status in (QuotationStatus.ACCEPTED.value, QuotationStatus.REJECTED.value):
        row.decided_at = now
    if row.lead_id:
        lead = db.get(CrmLead, row.lead_id)
        if lead is not None:
            _log(db, lead, viewer, "quotation",
                 f"Quotation {row.number} marked {payload.status}"
                 + (f" — {payload.note}" if payload.note else ""))
    db.commit()
    db.refresh(row)
    return _quotation_out(row)


def duplicate_quotation(db: Session, viewer: User, quotation_id: uuid.UUID) -> S.QuotationOut:
    """Copy an existing quotation into a fresh draft.

    The way a revision is made: the original stays exactly as the customer saw
    it, and the new one gets its own number.
    """
    source = _readable_quotation(db, viewer, quotation_id)
    payload = S.QuotationIn(
        quote_date=date.today(),
        valid_until=None,
        lead_id=source.lead_id, customer_id=source.customer_id,
        customer_name=source.customer_name, company=source.company, gstin=source.gstin,
        mobile=source.mobile, whatsapp=source.whatsapp, email=source.email,
        city=source.city, state=source.state, pincode=source.pincode,
        billing_address=source.billing_address, shipping_address=source.shipping_address,
        terms=source.terms, notes=source.notes,
        lines=[
            S.QuotationLineIn(
                name=line.name, product_id=line.product_id, plan_id=line.plan_id,
                description=line.description, hsn_sac=line.hsn_sac, quantity=line.quantity,
                rate=line.rate, discount=line.discount,
                discount_is_percent=line.discount_is_percent, gst_percent=line.gst_percent,
            )
            for line in source.lines
        ],
    )
    return create_quotation(db, viewer, payload)


def delete_quotation(db: Session, viewer: User, quotation_id: uuid.UUID) -> None:
    row = _readable_quotation(db, viewer, quotation_id)
    if row.status_enum is not QuotationStatus.DRAFT:
        raise HTTPException(
            http_status.HTTP_409_CONFLICT,
            detail={
                "reason": "not_a_draft",
                "message": "Only a draft can be deleted. Mark this one rejected or expired instead.",
            },
        )
    db.delete(row)
    db.commit()


# --------------------------------------------------------------------------- #
# Reminders
# --------------------------------------------------------------------------- #


def _reminder_recipient_count(db: Session, org_id: uuid.UUID, row: CrmReminder) -> int:
    """How many people this reminder would reach if it ran now."""
    if row.audience == "list":
        return len(row.recipients)
    model = CrmLead if row.audience == "leads" else CrmCustomer
    stmt = select(func.count()).select_from(model).where(model.org_id == org_id)
    status_ids = row.audience_filter.get("status_ids") if row.audience_filter else None
    if status_ids and row.audience == "leads":
        stmt = stmt.where(CrmLead.status_id.in_([uuid.UUID(str(s)) for s in status_ids]))
    if row.audience == "customers" and (row.audience_filter or {}).get("status"):
        stmt = stmt.where(CrmCustomer.status == row.audience_filter["status"])
    return db.scalar(stmt) or 0


def _scheduled_sends(row: CrmReminder) -> int:
    """Sends left between today and the end date. 0 when it never ends.

    Zero for an open-ended reminder rather than a large number: "runs until you
    stop it" is the honest answer, and the console says so rather than printing
    a count that is really a guess about how long the company will exist.
    """
    if row.end_on is None:
        return 0
    start = max(row.start_on, date.today())
    if start > row.end_on:
        return 0
    days = [start + timedelta(days=i) for i in range((row.end_on - start).days + 1)]
    if row.weekdays:
        days = [d for d in days if d.isoweekday() in row.weekdays]
    return len(days)


def _reminder_out(db: Session, org_id: uuid.UUID, row: CrmReminder) -> S.ReminderOut:
    return S.ReminderOut(
        id=row.id, name=row.name, message=row.message, image_url=row.image_url,
        template_name=row.template_name, audience=row.audience,
        audience_filter=row.audience_filter or {}, start_on=row.start_on, end_on=row.end_on,
        send_time=row.send_time, weekdays=row.weekdays or [], is_active=row.is_active,
        last_run_on=row.last_run_on, created_at=row.created_at,
        recipient_count=_reminder_recipient_count(db, org_id, row),
        scheduled_sends=_scheduled_sends(row),
        recipients=[S.ReminderRecipientOut.model_validate(r) for r in row.recipients],
    )


def list_reminders(db: Session, viewer: User) -> list[S.ReminderOut]:
    rows = db.scalars(
        select(CrmReminder)
        .where(CrmReminder.org_id == viewer.org_id)
        .options(selectinload(CrmReminder.recipients))
        .order_by(CrmReminder.created_at.desc())
    ).all()
    return [_reminder_out(db, viewer.org_id, row) for row in rows]


def save_reminder(
    db: Session, viewer: User, payload: S.ReminderIn, *, reminder_id: uuid.UUID | None = None
) -> S.ReminderOut:
    require_admin_crm(viewer)
    if reminder_id is None:
        row = CrmReminder(org_id=viewer.org_id, name=payload.name, start_on=payload.start_on)
        db.add(row)
        db.flush()
    else:
        row = db.get(CrmReminder, reminder_id)
        if row is None or row.org_id != viewer.org_id:
            raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Reminder not found")

    row.name = payload.name
    row.message = payload.message
    row.image_url = payload.image_url
    row.template_name = payload.template_name
    row.audience = payload.audience
    row.audience_filter = payload.audience_filter or {}
    row.start_on = payload.start_on
    row.end_on = payload.end_on
    row.send_time = payload.send_time
    row.weekdays = payload.weekdays
    row.is_active = payload.is_active

    # The hand-typed list is replaced wholesale, and only for the audience that
    # uses one — keeping stale rows around for a reminder that now targets every
    # customer would make the recipient count lie the moment it switched back.
    db.execute(
        delete(CrmReminderRecipient).where(CrmReminderRecipient.reminder_id == row.id)
    )
    if payload.audience == "list":
        seen: set[str] = set()
        for recipient in payload.recipients:
            mobile = recipient.mobile.strip()
            if mobile in seen:
                continue
            seen.add(mobile)
            db.add(CrmReminderRecipient(
                org_id=viewer.org_id, reminder_id=row.id, name=recipient.name, mobile=mobile
            ))
    db.commit()
    db.refresh(row)
    return _reminder_out(db, viewer.org_id, row)


def set_reminder_active(db: Session, viewer: User, reminder_id: uuid.UUID, active: bool) -> S.ReminderOut:
    require_admin_crm(viewer)
    row = db.get(CrmReminder, reminder_id)
    if row is None or row.org_id != viewer.org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Reminder not found")
    row.is_active = active
    db.commit()
    db.refresh(row)
    return _reminder_out(db, viewer.org_id, row)


def delete_reminder(db: Session, viewer: User, reminder_id: uuid.UUID) -> None:
    require_admin_crm(viewer)
    row = db.get(CrmReminder, reminder_id)
    if row is None or row.org_id != viewer.org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Reminder not found")
    db.delete(row)
    db.commit()


def reminder_history(db: Session, viewer: User, *, limit: int = 100) -> list[S.ReminderRunOut]:
    rows = db.scalars(
        select(CrmReminderRun)
        .where(CrmReminderRun.org_id == viewer.org_id)
        .options(selectinload(CrmReminderRun.reminder))
        .order_by(CrmReminderRun.created_at.desc())
        .limit(limit)
    ).all()
    return [
        S.ReminderRunOut(
            id=row.id, reminder_id=row.reminder_id,
            reminder_name=row.reminder.name if row.reminder else None,
            run_on=row.run_on, recipients=row.recipients, sent=row.sent, failed=row.failed,
            note=row.note, created_at=row.created_at,
        )
        for row in rows
    ]


# --------------------------------------------------------------------------- #
# Dashboard
# --------------------------------------------------------------------------- #


def dashboard(
    db: Session,
    viewer: User,
    *,
    date_from: date,
    date_to: date,
    owner_id: uuid.UUID | None = None,
    source_id: uuid.UUID | None = None,
    status_id: uuid.UUID | None = None,
) -> S.LeadDashboardOut:
    """Everything the Lead Dashboard draws, from one scan of the pipeline.

    Loaded and aggregated in Python rather than eight grouped queries. That is a
    deliberate trade: it is one round trip and one consistent moment, and the
    row count is the org's leads in a window — thousands, not millions. If a
    workspace ever outgrows it, the fix is a materialised daily rollup, not
    eight queries that can disagree with each other.
    """
    scope = visible_owner_ids(db, viewer)
    start = datetime.combine(date_from, time.min, timezone.utc)
    end = datetime.combine(date_to, time.max, timezone.utc)

    stmt = (
        select(CrmLead)
        .where(CrmLead.org_id == viewer.org_id)
        .options(selectinload(CrmLead.status), selectinload(CrmLead.source), selectinload(CrmLead.owner))
    )
    stmt = _scoped(stmt, CrmLead.owner_id, scope)
    if owner_id:
        stmt = stmt.where(CrmLead.owner_id == owner_id)
    if source_id:
        stmt = stmt.where(CrmLead.source_id == source_id)
    if status_id:
        stmt = stmt.where(CrmLead.status_id == status_id)

    every = db.scalars(stmt).all()
    window = [lead for lead in every if start <= _aware(lead.created_at) <= end]

    now = _now()
    today = now.date()
    is_won = lambda lead: bool(lead.status and lead.status.behaviour == StatusBehaviour.WON.value)  # noqa: E731
    is_lost = lambda lead: bool(lead.status and lead.status.behaviour == StatusBehaviour.LOST.value)  # noqa: E731

    converted = sum(1 for lead in window if lead.customer_id or is_won(lead))
    qualified = sum(
        1 for lead in window
        if lead.status and lead.status.behaviour == StatusBehaviour.IN_PROGRESS.value
    )

    # Follow-up counters read the whole pipeline, not the date window: work owed
    # today is owed whether or not the lead was created this month, and scoping
    # it to the filter would make "Follow-ups due today" change when somebody
    # picked a different date range.
    due_today = sum(
        1 for lead in every
        if lead.next_follow_up_at and _aware(lead.next_follow_up_at).date() == today
    )
    overdue = sum(
        1 for lead in every if lead.next_follow_up_at and _aware(lead.next_follow_up_at) < now
    )
    pending = sum(1 for lead in every if lead.next_follow_up_at is not None)

    # Trend: every day in the range appears, including the empty ones. A chart
    # that skips quiet days draws a busy week and a quiet week identically.
    span = (date_to - date_from).days
    buckets = {date_from + timedelta(days=i): [0, 0] for i in range(max(0, span) + 1)}
    for lead in window:
        day = _aware(lead.created_at).date()
        if day in buckets:
            buckets[day][0] += 1
        if lead.converted_at:
            converted_day = _aware(lead.converted_at).date()
            if converted_day in buckets:
                buckets[converted_day][1] += 1

    stages = db.scalars(
        select(CrmLeadStatus)
        .where(CrmLeadStatus.org_id == viewer.org_id)
        .order_by(CrmLeadStatus.sort_order)
    ).all()
    total_window = len(window) or 1
    funnel = [
        S.FunnelStage(
            status_id=stage.id, name=stage.name, colour=stage.colour, behaviour=stage.behaviour,
            count=sum(1 for lead in window if lead.status_id == stage.id),
            percent=round(
                sum(1 for lead in window if lead.status_id == stage.id) * 100 / total_window, 1
            ),
        )
        for stage in stages
    ]

    by_source: dict[str, list[int]] = {}
    for lead in window:
        key = lead.source.name if lead.source else "Unknown"
        entry = by_source.setdefault(key, [0, 0])
        entry[0] += 1
        if lead.customer_id or is_won(lead):
            entry[1] += 1

    by_owner: dict[tuple[uuid.UUID | None, str], list[int]] = {}
    for lead in every:
        key = (lead.owner_id, lead.owner.full_name if lead.owner else "Unassigned")
        entry = by_owner.setdefault(key, [0, 0, 0])
        entry[0] += 1
        if lead.customer_id or is_won(lead):
            entry[1] += 1
        if lead.next_follow_up_at is not None:
            entry[2] += 1

    return S.LeadDashboardOut(
        total_leads=len(window),
        total_leads_all_time=len(every),
        new_leads=len(window),
        todays_leads=sum(1 for lead in every if _aware(lead.created_at).date() == today),
        follow_ups_due_today=due_today,
        pending_follow_ups=pending,
        overdue_follow_ups=overdue,
        qualified_leads=qualified,
        converted_leads=converted,
        lost_leads=sum(1 for lead in window if is_lost(lead)),
        conversion_rate=round(converted * 100 / len(window), 1) if window else 0.0,
        trend=[
            S.TrendPoint(day=day, new_leads=counts[0], converted=counts[1])
            for day, counts in sorted(buckets.items())
        ],
        funnel=funnel,
        sources=[
            S.SourceStat(
                name=name, count=counts[0], converted=counts[1],
                conversion_rate=round(counts[1] * 100 / counts[0], 1) if counts[0] else 0.0,
            )
            for name, counts in sorted(by_source.items(), key=lambda kv: -kv[1][0])
        ],
        owners=[
            S.OwnerStat(
                owner_id=key[0], name=key[1], total=counts[0], converted=counts[1],
                pending_follow_ups=counts[2],
                conversion_rate=round(counts[1] * 100 / counts[0], 1) if counts[0] else 0.0,
            )
            for key, counts in sorted(by_owner.items(), key=lambda kv: -kv[1][0])
        ],
    )


def export_leads_csv(db: Session, viewer: User, **filters: Any) -> str:
    """The lead list as CSV text.

    Built here rather than in the router so the export goes through exactly the
    same scope and filters as the table it was exported from — an export that
    quietly returns more rows than the screen is a data leak with a download
    button on it.
    """
    import csv
    import io

    page = list_leads(db, viewer, page=1, page_size=200, **filters)
    total = page.total
    rows = list(page.rows)
    fetched = len(rows)
    # Page through the rest rather than raising the page size: the cap in
    # `list_leads` is what stops one request loading a whole workspace.
    while fetched < total and len(rows) < 10_000:
        page = list_leads(db, viewer, page=(len(rows) // 200) + 1, page_size=200, **filters)
        if not page.rows:
            break
        rows.extend(page.rows)
        fetched += len(page.rows)

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow([
        "Lead ID", "Name", "Company", "Mobile", "WhatsApp", "Email", "Product/Service",
        "Source", "Status", "Owner", "City", "State", "Pincode", "Next follow-up", "Created",
    ])
    for row in rows:
        writer.writerow([
            row.code, row.name, row.company or "", row.mobile, row.whatsapp or "",
            row.email or "", row.product_name or "", row.source_name or "",
            row.status_name or "", row.owner_name or "", row.city_name or "",
            row.state_name or "", row.pincode or "",
            row.next_follow_up_at.isoformat() if row.next_follow_up_at else "",
            row.created_at.isoformat(),
        ])
    return buffer.getvalue()


def run_due_reminders(*, on: date | None = None) -> dict:
    """Fire whichever scheduled reminders are due, across every organisation.

    Called by ``app.scheduler`` once an hour. Hourly rather than nightly because
    a reminder carries a *time of day* in the organisation's own timezone, and a
    single nightly pass would send a 10:00 message at whatever hour the job
    happened to run.

    **There is no WhatsApp channel in this product yet, and this function does
    not pretend otherwise.** It resolves the audience, writes the run row the
    History tab reads, and records honestly that nothing was delivered. That is
    deliberate: a scheduler that silently does nothing is indistinguishable from
    one that is broken, and the run row is what lets an administrator see the
    difference. When a provider is wired in, the loop below is where the send
    goes — everything around it already works.

    Idempotent per day: ``last_run_on`` and the unique ``(reminder, run_on)``
    constraint together mean a restart, a second worker, or an hour that fires
    twice cannot double-send.
    """
    from zoneinfo import ZoneInfo

    from app.db.session import SessionLocal

    fired = 0
    with SessionLocal() as db:
        orgs = db.scalars(
            select(Organization).join(
                CrmSettings, CrmSettings.org_id == Organization.id
            ).where(CrmSettings.reminders_enabled.is_(True))
        ).all()

        for org in orgs:
            try:
                local = datetime.now(ZoneInfo(org.timezone or "UTC"))
            except Exception:  # noqa: BLE001 - a bad timezone string must not stop other tenants
                local = datetime.now(timezone.utc)
            today = on or local.date()

            reminders = db.scalars(
                select(CrmReminder)
                .where(CrmReminder.org_id == org.id, CrmReminder.is_active.is_(True))
                .options(selectinload(CrmReminder.recipients))
            ).all()

            for reminder in reminders:
                if reminder.last_run_on == today:
                    continue
                if reminder.start_on > today:
                    continue
                if reminder.end_on and reminder.end_on < today:
                    continue
                if reminder.weekdays and today.isoweekday() not in reminder.weekdays:
                    continue
                hour, _, minute = reminder.send_time.partition(":")
                if (local.hour, local.minute) < (int(hour), int(minute)):
                    continue

                recipients = _reminder_recipient_count(db, org.id, reminder)
                db.add(CrmReminderRun(
                    org_id=org.id, reminder_id=reminder.id, run_on=today,
                    recipients=recipients, sent=0, failed=0,
                    note=(
                        "No WhatsApp sender is configured for this workspace, so nothing "
                        "was delivered. The audience was resolved and is recorded here."
                    ),
                ))
                reminder.last_run_on = today
                fired += 1
        db.commit()
    return {"reminders_fired": fired}
