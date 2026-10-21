"""Masters: warehouses, items, vendors and the customer's financial account.

Masters are soft: once referenced they are deactivated, never deleted, so a
purchase order from last March still names its vendor (§6.x.6, "referenced
master data that is inactive shall be blocked from new transactions while
remaining visible in historical records").
"""

from __future__ import annotations

import re
import uuid
from datetime import date, datetime, timezone

from fastapi import Request
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import CrmCustomer, User
from app.models.erp import (
    ErpCustomerAccount,
    ErpCustomerSite,
    ErpItem,
    ErpPurchaseOrder,
    ErpStockBalance,
    ErpVendor,
    ErpVendorBank,
    ErpWarehouse,
    PoStatus,
    VendorStatus,
)
from app.schemas import erp as S
from app.services.erp.common import (
    ErpError,
    get_owned,
    get_settings,
    next_number,
    record_audit,
    require,
    require_reason,
    row_dict,
    user_names,
)

GSTIN_RE = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")
PAN_RE = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _commit_unique(db: Session, message: str) -> None:
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ErpError("duplicate", message, 409) from None


# --------------------------------------------------------------------------- #
# Warehouses
# --------------------------------------------------------------------------- #


def list_warehouses(db: Session, viewer: User, *, active_only: bool = False) -> list[dict]:
    stmt = select(ErpWarehouse).where(ErpWarehouse.org_id == viewer.org_id)
    if active_only:
        stmt = stmt.where(ErpWarehouse.is_active.is_(True))
    rows = list(db.scalars(stmt.order_by(ErpWarehouse.name)))
    names = user_names(db, viewer.org_id, [r.custodian_id for r in rows])
    return [{**row_dict(r), "custodian_name": names.get(r.custodian_id)} for r in rows]


def save_warehouse(
    db: Session, viewer: User, payload: S.WarehouseIn, row_id: uuid.UUID | None = None,
    request: Request | None = None,
) -> dict:
    require(viewer, "can_manage_erp_masters")
    row = (
        get_owned(db, ErpWarehouse, viewer.org_id, row_id, "warehouse")
        if row_id else ErpWarehouse(org_id=viewer.org_id)
    )
    for field, value in payload.model_dump().items():
        setattr(row, field, value.strip().upper() if field == "code" else value)
    db.add(row)
    db.flush()
    record_audit(db, viewer, "warehouse.saved", row, request=request, detail={"code": row.code})
    _commit_unique(db, f"Warehouse code “{payload.code}” is already used.")
    return row_dict(row)


# --------------------------------------------------------------------------- #
# Items
# --------------------------------------------------------------------------- #


def list_items(
    db: Session, viewer: User, *, q: str | None = None, active_only: bool = False,
    item_type: str | None = None,
) -> list[dict]:
    stmt = select(ErpItem).where(ErpItem.org_id == viewer.org_id)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(
            ErpItem.code.ilike(like), ErpItem.name.ilike(like),
            ErpItem.part_number.ilike(like), ErpItem.make.ilike(like),
        ))
    if active_only:
        stmt = stmt.where(ErpItem.is_active.is_(True))
    if item_type:
        stmt = stmt.where(ErpItem.item_type == item_type)
    rows = list(db.scalars(stmt.order_by(ErpItem.name).limit(1000)))
    on_hand = dict(db.execute(
        select(ErpStockBalance.item_id, func.sum(ErpStockBalance.quantity - ErpStockBalance.reserved_qty))
        .where(ErpStockBalance.org_id == viewer.org_id, ErpStockBalance.condition == "good")
        .group_by(ErpStockBalance.item_id)
    ).all())
    out = []
    for row in rows:
        available = on_hand.get(row.id) or 0
        out.append({
            **row_dict(row),
            "available_qty": str(available),
            "below_reorder": bool(row.is_stocked and row.reorder_level and available <= row.reorder_level),
        })
    return out


def save_item(
    db: Session, viewer: User, payload: S.ItemIn, row_id: uuid.UUID | None = None,
    request: Request | None = None,
) -> dict:
    require(viewer, "can_manage_erp_masters")
    row = (
        get_owned(db, ErpItem, viewer.org_id, row_id, "item")
        if row_id else ErpItem(org_id=viewer.org_id)
    )
    if row_id and row.is_serialized != payload.is_serialized:
        held = db.scalar(select(func.coalesce(func.sum(ErpStockBalance.quantity), 0)).where(
            ErpStockBalance.item_id == row.id))
        if held:
            # Turning serial tracking on for stock that arrived without serials
            # would leave units nobody can dispatch; off, units whose serials are
            # suddenly untracked. Either way, it waits for an empty shelf.
            raise ErpError(
                "item_in_stock",
                "Serial tracking cannot change while the item has stock on hand.", 409,
            )
    if payload.item_type == "service" and payload.is_serialized:
        raise ErpError("service_serialized", "A service has no serial numbers.")
    for field, value in payload.model_dump().items():
        setattr(row, field, value.strip().upper() if field == "code" else value)
    db.add(row)
    db.flush()
    record_audit(db, viewer, "item.saved", row, request=request, detail={"code": row.code})
    _commit_unique(db, f"Item code “{payload.code}” is already used.")
    return row_dict(row)


# --------------------------------------------------------------------------- #
# Vendors
# --------------------------------------------------------------------------- #


def _vendor_out(db: Session, row: ErpVendor) -> dict:
    names = user_names(db, row.org_id, [row.created_by, row.approved_by]
                       + [b.created_by for b in row.banks] + [b.verified_by for b in row.banks])
    today = date.today()
    return {
        **row_dict(row),
        "created_by_name": names.get(row.created_by),
        "approved_by_name": names.get(row.approved_by),
        "agreement_expired": bool(row.agreement_expiry and row.agreement_expiry < today),
        "banks": [
            {
                **row_dict(b),
                # Masked except the last four: a bank number on a list screen is
                # read over shoulders, and the full value is only needed by the
                # payment run, which this phase does not include.
                "account_number": f"••••{b.account_number[-4:]}",
                "created_by_name": names.get(b.created_by),
                "verified_by_name": names.get(b.verified_by),
            }
            for b in row.banks
        ],
    }


def list_vendors(
    db: Session, viewer: User, *, q: str | None = None, status: str | None = None,
) -> list[dict]:
    stmt = select(ErpVendor).where(ErpVendor.org_id == viewer.org_id)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(
            ErpVendor.legal_name.ilike(like), ErpVendor.code.ilike(like),
            ErpVendor.gstin.ilike(like), ErpVendor.pan.ilike(like),
        ))
    if status:
        stmt = stmt.where(ErpVendor.status == status)
    return [_vendor_out(db, r) for r in db.scalars(stmt.order_by(ErpVendor.legal_name))]


def get_vendor(db: Session, viewer: User, vendor_id: uuid.UUID) -> dict:
    return _vendor_out(db, get_owned(db, ErpVendor, viewer.org_id, vendor_id, "vendor"))


def _check_tax_ids(payload: S.VendorIn | S.CustomerAccountIn) -> None:
    if payload.gstin:
        payload.gstin = payload.gstin.strip().upper()
        if not GSTIN_RE.match(payload.gstin):
            raise ErpError("bad_gstin", f"“{payload.gstin}” is not a valid GSTIN.")
    if payload.pan:
        payload.pan = payload.pan.strip().upper()
        if not PAN_RE.match(payload.pan):
            raise ErpError("bad_pan", f"“{payload.pan}” is not a valid PAN.")
    if payload.gstin and payload.pan and payload.gstin[2:12] != payload.pan:
        raise ErpError("gstin_pan_mismatch", "The PAN inside the GSTIN does not match the PAN given.")


def save_vendor(
    db: Session, viewer: User, payload: S.VendorIn, row_id: uuid.UUID | None = None,
    request: Request | None = None,
) -> dict:
    require(viewer, "can_manage_erp_masters")
    _check_tax_ids(payload)
    row = (
        get_owned(db, ErpVendor, viewer.org_id, row_id, "vendor")
        if row_id else ErpVendor(org_id=viewer.org_id, created_by=viewer.id)
    )

    # Duplicate prevention by PAN / GSTIN / legal name — FR-07.01.
    clauses = [func.lower(ErpVendor.legal_name) == payload.legal_name.strip().lower()]
    if payload.gstin:
        clauses.append(ErpVendor.gstin == payload.gstin)
    if payload.pan:
        clauses.append(ErpVendor.pan == payload.pan)
    clash = db.scalar(select(ErpVendor).where(
        ErpVendor.org_id == viewer.org_id, or_(*clauses),
        *( [ErpVendor.id != row.id] if row_id else [] ),
    ))
    if clash is not None:
        raise ErpError(
            "duplicate_vendor",
            f"{clash.legal_name} ({clash.code}) already has this name, GSTIN or PAN.", 409,
        )

    data = payload.model_dump()
    code = (data.pop("code") or "").strip().upper()
    if not row_id:
        row.code = code or next_number(db, viewer.org_id, "VEN", date.today()).replace("/", "-")
    elif code:
        row.code = code
    tax_identity_changed = bool(row_id) and (
        row.gstin != data["gstin"] or row.pan != data["pan"] or row.legal_name != data["legal_name"]
    )
    for field, value in data.items():
        setattr(row, field, value)
    if tax_identity_changed and row.status == VendorStatus.ACTIVE.value:
        # An active vendor's legal or tax identity changing is the same risk as
        # its bank changing: it goes back for approval rather than trusting the
        # edit, and stops being purchasable until somebody else has looked.
        row.status = VendorStatus.PENDING.value
        row.status_reason = "Legal name, GSTIN or PAN changed — awaiting re-approval"
    db.add(row)
    db.flush()
    record_audit(db, viewer, "vendor.saved", row, request=request, detail={"code": row.code})
    _commit_unique(db, "That vendor code is already used.")
    db.refresh(row)
    return _vendor_out(db, row)


def submit_vendor(db: Session, viewer: User, vendor_id: uuid.UUID, request: Request | None = None) -> dict:
    require(viewer, "can_manage_erp_masters")
    row = get_owned(db, ErpVendor, viewer.org_id, vendor_id, "vendor")
    if row.status != VendorStatus.DRAFT.value:
        raise ErpError("not_draft", f"This vendor is {row.status}, not a draft.", 409)
    if not (row.gstin or row.pan):
        raise ErpError("kyc_incomplete", "A GSTIN or a PAN is needed before approval.")
    row.status = VendorStatus.PENDING.value
    record_audit(db, viewer, "vendor.submitted", row, request=request)
    db.commit()
    return _vendor_out(db, row)


def decide_vendor(
    db: Session, viewer: User, vendor_id: uuid.UUID, payload: S.DecisionIn,
    request: Request | None = None,
) -> dict:
    """Activate or send back. Never by the person who created it (§6.7.5)."""
    require(viewer, "can_verify_vendors")
    row = get_owned(db, ErpVendor, viewer.org_id, vendor_id, "vendor")
    if row.status != VendorStatus.PENDING.value:
        raise ErpError("not_pending", f"This vendor is {row.status}, not awaiting approval.", 409)
    if row.created_by == viewer.id:
        raise ErpError("self_review", "You created this vendor; somebody else must approve it.", 403)
    if payload.approve:
        row.status = VendorStatus.ACTIVE.value
        row.approved_by = viewer.id
        row.approved_at = _now()
        row.status_reason = None
    else:
        row.status = VendorStatus.DRAFT.value
        row.status_reason = require_reason(payload.note, "vendor is sent back")
    record_audit(db, viewer, "vendor.decided", row, request=request,
                 detail={"approve": payload.approve, "note": payload.note})
    db.commit()
    return _vendor_out(db, row)


def set_vendor_status(
    db: Session, viewer: User, vendor_id: uuid.UUID, payload: S.VendorStatusIn,
    request: Request | None = None,
) -> dict:
    """Suspend, blacklist, or reactivate — FR-07.13. Reactivation of a suspended
    vendor is the controlled path the risk register asks for: same approver
    capability, with a reason."""
    require(viewer, "can_verify_vendors")
    row = get_owned(db, ErpVendor, viewer.org_id, vendor_id, "vendor")
    if row.status in (VendorStatus.DRAFT.value, VendorStatus.PENDING.value):
        raise ErpError("not_active", "Approve the vendor first.", 409)
    reason = require_reason(payload.reason, "vendor status changes")
    previous = row.status
    row.status = payload.status
    row.status_reason = reason
    row.status_effective = payload.effective or date.today()
    record_audit(db, viewer, "vendor.status", row, request=request,
                 detail={"from": previous, "to": payload.status, "reason": reason})
    db.commit()
    return _vendor_out(db, row)


def add_vendor_bank(
    db: Session, viewer: User, vendor_id: uuid.UUID, payload: S.VendorBankIn,
    request: Request | None = None,
) -> dict:
    require(viewer, "can_manage_erp_masters")
    row = get_owned(db, ErpVendor, viewer.org_id, vendor_id, "vendor")
    ifsc = payload.ifsc.strip().upper()
    if not re.match(r"^[A-Z]{4}0[A-Z0-9]{6}$", ifsc):
        raise ErpError("bad_ifsc", f"“{ifsc}” is not a valid IFSC.")
    bank = ErpVendorBank(
        org_id=viewer.org_id, vendor_id=row.id, account_name=payload.account_name.strip(),
        account_number=payload.account_number.strip(), ifsc=ifsc,
        bank_name=payload.bank_name, created_by=viewer.id,
    )
    db.add(bank)
    db.flush()
    record_audit(db, viewer, "vendor.bank_added", row, request=request,
                 detail={"bank_id": str(bank.id), "last4": bank.account_number[-4:], "ifsc": ifsc})
    db.commit()
    db.refresh(row)
    return _vendor_out(db, row)


def verify_vendor_bank(
    db: Session, viewer: User, vendor_id: uuid.UUID, bank_id: uuid.UUID, payload: S.DecisionIn,
    request: Request | None = None,
) -> dict:
    """The checker. A verified account supersedes any previously verified one."""
    require(viewer, "can_verify_vendors")
    vendor = get_owned(db, ErpVendor, viewer.org_id, vendor_id, "vendor")
    bank = get_owned(db, ErpVendorBank, viewer.org_id, bank_id, "bank account")
    if bank.vendor_id != vendor.id:
        raise ErpError("not_found", "No such bank account.", 404)
    if bank.status != "pending":
        raise ErpError("not_pending", f"This account is {bank.status}.", 409)
    if bank.created_by == viewer.id:
        raise ErpError("self_review", "You entered this account; somebody else must verify it.", 403)
    if payload.approve:
        for other in vendor.banks:
            if other.id != bank.id and other.status == "verified":
                other.status = "superseded"
        bank.status = "verified"
        bank.note = payload.note
    else:
        bank.status = "rejected"
        bank.note = require_reason(payload.note, "account is rejected")
    bank.verified_by = viewer.id
    bank.verified_at = _now()
    record_audit(db, viewer, "vendor.bank_verified", vendor, request=request,
                 detail={"bank_id": str(bank.id), "approve": payload.approve})
    db.commit()
    db.refresh(vendor)
    return _vendor_out(db, vendor)


def purchasable_vendor(db: Session, org_id: uuid.UUID, vendor_id: uuid.UUID) -> ErpVendor:
    """The vendor, if an order may be placed with them today."""
    vendor = get_owned(db, ErpVendor, org_id, vendor_id, "vendor")
    if vendor.status != VendorStatus.ACTIVE.value:
        raise ErpError(
            "vendor_not_active",
            f"{vendor.legal_name} is {vendor.status} — orders go only to approved, active vendors.",
            409,
        )
    return vendor


def refresh_vendor_score(db: Session, vendor_id: uuid.UUID) -> None:
    """1–5 from delivery against committed dates and accepted quantity (FR-07.10).

    Deliberately simple and explainable: half the score is the share of GRNs
    that arrived on time, half the share of received quantity accepted. A score
    nobody can reproduce on a calculator is a score nobody trusts.
    """
    from app.models.erp import ErpGoodsReceipt, ErpGoodsReceiptLine

    grns = list(db.scalars(select(ErpGoodsReceipt).where(
        ErpGoodsReceipt.vendor_id == vendor_id, ErpGoodsReceipt.status == "posted")))
    vendor = db.get(ErpVendor, vendor_id)
    if not grns or vendor is None:
        return
    on_time = sum(1 for g in grns if g.days_late <= 0) / len(grns)
    totals = db.execute(select(
        func.coalesce(func.sum(ErpGoodsReceiptLine.received_qty), 0),
        func.coalesce(func.sum(ErpGoodsReceiptLine.accepted_qty), 0),
    ).where(ErpGoodsReceiptLine.receipt_id.in_([g.id for g in grns]))).one()
    accepted = (float(totals[1]) / float(totals[0])) if totals[0] else 1.0
    from decimal import Decimal

    vendor.performance_score = Decimal(str(round(1 + 4 * (on_time + accepted) / 2, 2)))


# --------------------------------------------------------------------------- #
# Customer accounts
# --------------------------------------------------------------------------- #


def _account_out(db: Session, customer: CrmCustomer, account: ErpCustomerAccount | None) -> dict:
    from app.services.erp import billing

    exposure = billing.customer_exposure(db, customer.org_id, customer.id)
    return {
        "customer_id": str(customer.id),
        "customer_code": customer.code,
        "customer_name": customer.company or customer.name,
        "contact_name": customer.name,
        "mobile": customer.mobile,
        "email": customer.email,
        "crm_gstin": customer.gstin,
        "account": (
            {**row_dict(account), "sites": [row_dict(s) for s in account.sites]}
            if account else None
        ),
        **exposure,
    }


def ensure_account(db: Session, org_id: uuid.UUID, customer_id: uuid.UUID) -> ErpCustomerAccount:
    """The customer's account, created from the CRM record on first use.

    Created lazily rather than for every CRM customer: most leads that convert
    never get an order, and an account row per customer would be a second
    customer list in all but name.
    """
    customer = get_owned(db, CrmCustomer, org_id, customer_id, "customer")
    account = db.scalar(select(ErpCustomerAccount).where(
        ErpCustomerAccount.org_id == org_id, ErpCustomerAccount.customer_id == customer.id))
    if account is None:
        settings = get_settings(db, org_id)
        account = ErpCustomerAccount(
            org_id=org_id, customer_id=customer.id,
            legal_name=customer.company or customer.name, gstin=customer.gstin,
            billing_address=customer.address,
            billing_state=customer.state.name if customer.state else None,
            shipping_address=customer.address, credit_days=settings.default_credit_days,
        )
        db.add(account)
        db.flush()
    return account


def list_customer_accounts(db: Session, viewer: User, *, q: str | None = None) -> list[dict]:
    stmt = select(CrmCustomer).where(CrmCustomer.org_id == viewer.org_id)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(CrmCustomer.name.ilike(like), CrmCustomer.company.ilike(like),
                              CrmCustomer.code.ilike(like), CrmCustomer.gstin.ilike(like)))
    customers = list(db.scalars(stmt.order_by(CrmCustomer.name).limit(500)))
    accounts = {
        a.customer_id: a for a in db.scalars(select(ErpCustomerAccount).where(
            ErpCustomerAccount.org_id == viewer.org_id))
    }
    return [_account_out(db, c, accounts.get(c.id)) for c in customers]


def get_customer_account(db: Session, viewer: User, customer_id: uuid.UUID) -> dict:
    customer = get_owned(db, CrmCustomer, viewer.org_id, customer_id, "customer")
    account = db.scalar(select(ErpCustomerAccount).where(
        ErpCustomerAccount.org_id == viewer.org_id, ErpCustomerAccount.customer_id == customer.id))
    return _account_out(db, customer, account)


def save_customer_account(
    db: Session, viewer: User, customer_id: uuid.UUID, payload: S.CustomerAccountIn,
    request: Request | None = None,
) -> dict:
    """Terms and addresses. The credit *hold* is not here — see :func:`set_credit_hold`."""
    require(viewer, "can_manage_billing")
    _check_tax_ids(payload)
    account = ensure_account(db, viewer.org_id, customer_id)
    for field, value in payload.model_dump().items():
        setattr(account, field, value)
    record_audit(db, viewer, "customer_account.saved", account, request=request,
                 detail={"credit_limit": str(payload.credit_limit), "credit_days": payload.credit_days})
    db.commit()
    return get_customer_account(db, viewer, customer_id)


def set_credit_hold(
    db: Session, viewer: User, customer_id: uuid.UUID, payload: S.CreditHoldIn,
    request: Request | None = None,
) -> dict:
    """FR-04.13: controlled by Finance. Placing and releasing both need a reason."""
    require(viewer, "can_approve_billing")
    account = ensure_account(db, viewer.org_id, customer_id)
    reason = require_reason(payload.reason, "hold changes")
    account.credit_hold = payload.hold
    account.hold_reason = reason if payload.hold else None
    record_audit(db, viewer, "customer_account.hold", account, request=request,
                 detail={"hold": payload.hold, "reason": reason})
    db.commit()
    return get_customer_account(db, viewer, customer_id)


def add_site(
    db: Session, viewer: User, customer_id: uuid.UUID, payload: S.CustomerSiteIn,
    site_id: uuid.UUID | None = None, request: Request | None = None,
) -> dict:
    require(viewer, "can_manage_sales_orders")
    account = ensure_account(db, viewer.org_id, customer_id)
    if site_id:
        site = get_owned(db, ErpCustomerSite, viewer.org_id, site_id, "site")
        if site.account_id != account.id:
            raise ErpError("not_found", "No such site.", 404)
    else:
        site = ErpCustomerSite(org_id=viewer.org_id, account_id=account.id)
    for field, value in payload.model_dump().items():
        setattr(site, field, value)
    db.add(site)
    db.flush()
    record_audit(db, viewer, "customer_site.saved", account, request=request, detail={"site": site.name})
    db.commit()
    return get_customer_account(db, viewer, customer_id)


def open_po_count(db: Session, vendor_id: uuid.UUID) -> int:
    return db.scalar(select(func.count()).select_from(ErpPurchaseOrder).where(
        ErpPurchaseOrder.vendor_id == vendor_id,
        ErpPurchaseOrder.status.in_([s.value for s in PoStatus if s.is_receivable]),
    )) or 0
