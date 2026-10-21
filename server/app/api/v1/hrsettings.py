"""HR settings — ``/hr/settings``.

Readable by anyone signed in: the hire form needs the default probation and
the next employee ID, and the HR dashboard its warning windows. Writable by
administrators only.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.api.deps import AdminUser, CurrentUser, DbSession
from app.services import hrsettings as svc

router = APIRouter(prefix="/hr", tags=["hr-settings"])


class HrSettingsIn(BaseModel):
    emp_code_prefix: str = Field("", max_length=12)
    emp_code_separator: str = Field("", max_length=3)
    emp_code_digits: int = Field(4, ge=0, le=10)
    emp_code_next: int = Field(1, ge=1, le=10_000_000)
    default_probation_months: int = Field(6, ge=0, le=36)
    default_notice_days: int = Field(30, ge=0, le=365)
    probation_warn_days: int = Field(30, ge=1, le=365)
    document_warn_days: int = Field(60, ge=1, le=365)


class HrSettingsOut(HrSettingsIn):
    #: The code the next employee will get with this format.
    next_code: str


def _out(db, org_id) -> HrSettingsOut:
    row = svc.get_settings(db, org_id)
    return HrSettingsOut(
        emp_code_prefix=row.emp_code_prefix,
        emp_code_separator=row.emp_code_separator,
        emp_code_digits=row.emp_code_digits,
        emp_code_next=row.emp_code_next,
        default_probation_months=row.default_probation_months,
        default_notice_days=row.default_notice_days,
        probation_warn_days=row.probation_warn_days,
        document_warn_days=row.document_warn_days,
        next_code=svc.preview_code(db, org_id),
    )


@router.get("/settings", response_model=HrSettingsOut)
def read_settings(viewer: CurrentUser, db: DbSession) -> HrSettingsOut:
    out = _out(db, viewer.org_id)
    db.commit()  # the row may have just been created
    return out


@router.put("/settings", response_model=HrSettingsOut)
def write_settings(payload: HrSettingsIn, admin: AdminUser, db: DbSession) -> HrSettingsOut:
    row = svc.get_settings(db, admin.org_id)
    data = payload.model_dump()
    data["emp_code_prefix"] = data["emp_code_prefix"].strip().upper()
    for key, value in data.items():
        setattr(row, key, value)
    db.flush()
    out = _out(db, admin.org_id)
    db.commit()
    return out
