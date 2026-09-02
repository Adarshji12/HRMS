"""Pre-payroll readiness, and variance against the previous month.

Two read-only reports either side of the compute step, and the tests are
weighted at the two ways either could be worse than useless:

* **A check that misses somebody.** A person with no bank account who does not
  appear on the list is a person who finds out on payday.
* **A variance report that explains nothing.** "Net moved by ₹8,000" with no
  reason is a row somebody has to reconstruct by hand, which is the work the
  report exists to remove.

Neither report blocks anything, and one test holds that line: computing an
unready month is allowed, because every check has a legitimate "yes, I know".
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from app.db.session import SessionLocal
from app.models import EmployeeProfile, LeaveApplication, User

from tests.test_payrun import _catalogue, _computed, _run, _salary


def _checks(client, tenant, run_id) -> dict[str, dict]:
    response = client.get(f"/api/v1/payruns/{run_id}/readiness", headers=tenant.headers())
    assert response.status_code == 200, response.text
    return {row["key"]: row for row in response.json()}


def _variance(client, tenant, run_id, **params):
    query = "&".join(f"{k}={v}" for k, v in params.items())
    response = client.get(
        f"/api/v1/payruns/{run_id}/variance{'?' + query if query else ''}",
        headers=tenant.headers(),
    )
    assert response.status_code == 200, response.text
    return response.json()


# --------------------------------------------------------------------------- #
# Readiness
# --------------------------------------------------------------------------- #


def test_somebody_with_no_salary_structure_is_named(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    # Only the employee gets a salary; the owner is left without one.
    _salary(client, acme, acme.employee.id, catalogue)
    run = _run(client, acme)

    check = _checks(client, acme, run["id"])["no_structure"]
    assert check["severity"] == "blocking"
    assert check["count"] == 1
    assert acme.owner.full_name in check["names"]


def test_everybody_with_a_structure_clears_that_check(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    for person in (acme.owner, acme.employee):
        _salary(client, acme, person.id, catalogue)
    run = _run(client, acme)

    assert _checks(client, acme, run["id"])["no_structure"]["count"] == 0


def test_a_missing_bank_account_is_blocking(client, tenants):
    """The bank file refuses to leave anybody out, so this has to be found
    before payday rather than by the file failing to generate."""
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue)
    run = _run(client, acme)

    check = _checks(client, acme, run["id"])["no_bank"]
    assert check["severity"] == "blocking"
    # Nobody in the fixture has bank details, so everybody active is named.
    assert check["count"] >= 1
    assert acme.employee.full_name in check["names"]


def test_a_filled_in_bank_account_clears_the_check(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue)
    run = _run(client, acme)

    with SessionLocal() as db:
        for person in db.scalars(select_users(acme.id)):
            db.add(EmployeeProfile(
                org_id=acme.id, user_id=person.id,
                bank_ifsc="HDFC0001234", bank_account_enc="encrypted",
                bank_account_name=person.full_name,
            ))
        db.commit()

    assert _checks(client, acme, run["id"])["no_bank"]["count"] == 0


def select_users(org_id):
    from sqlalchemy import select

    return select(User).where(User.org_id == org_id, User.is_active.is_(True))


def test_leave_awaiting_a_decision_is_reported_for_the_period(client, tenants):
    """Approving leave after computing changes the loss of pay, and the run has
    to be computed again — so it is worth knowing first."""
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue)
    run = _run(client, acme, year=2026, month=6)

    with SessionLocal() as db:
        leave_type = _any_leave_type(db, acme.id)
        db.add(LeaveApplication(
            org_id=acme.id, user_id=acme.employee.id, leave_type_id=leave_type,
            start_date=date(2026, 6, 10), end_date=date(2026, 6, 12),
            duration_milli_days=3000, status="pending", reason="Family",
            applied_at=datetime.now(timezone.utc),
        ))
        # A pending application in another month must not appear.
        db.add(LeaveApplication(
            org_id=acme.id, user_id=acme.employee.id, leave_type_id=leave_type,
            start_date=date(2026, 9, 10), end_date=date(2026, 9, 11),
            duration_milli_days=2000, status="pending", reason="Later",
            applied_at=datetime.now(timezone.utc),
        ))
        db.commit()

    check = _checks(client, acme, run["id"])["pending_leave"]
    assert check["count"] == 1
    assert "10 Jun" in check["names"][0]


def _any_leave_type(db, org_id):
    """A leave type to hang an application on, made if the org has none."""
    from sqlalchemy import select

    from app.models import LeaveType

    existing = db.scalar(select(LeaveType).where(LeaveType.org_id == org_id))
    if existing:
        return existing.id
    made = LeaveType(org_id=org_id, code="CL", name="Casual Leave")
    db.add(made)
    db.flush()
    return made.id


def test_joiners_this_month_are_listed_as_information(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue)

    with SessionLocal() as db:
        person = db.get(User, acme.employee.id)
        person.joined_on = date(2026, 6, 15)
        db.commit()

    run = _run(client, acme, year=2026, month=6)
    check = _checks(client, acme, run["id"])["joiners"]
    assert check["severity"] == "info"
    assert check["count"] == 1
    assert "joined 15 Jun" in check["names"][0]


def test_the_checklist_never_blocks_computing(client, tenants):
    """Every check has a legitimate "yes, I know" — a consultant with no bank
    row, a month somebody genuinely earned nothing. A hard gate would be a gate
    people learn to work around."""
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue)
    run = _run(client, acme)

    assert _checks(client, acme, run["id"])["no_bank"]["count"] > 0
    computed = _computed(client, acme, run["id"])
    assert computed["status"] == "computed"


def test_readiness_is_payroll_only(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue)
    run = _run(client, acme)

    refused = client.get(
        f"/api/v1/payruns/{run['id']}/readiness",
        headers=acme.headers(acme.employee_token),
    )
    assert refused.status_code == 403


def test_readiness_does_not_cross_the_tenant_boundary(client, tenants):
    acme, globex = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue)
    run = _run(client, acme)

    assert client.get(
        f"/api/v1/payruns/{run['id']}/readiness", headers=globex.headers()
    ).status_code == 404


# --------------------------------------------------------------------------- #
# Variance
# --------------------------------------------------------------------------- #


def test_a_first_run_reports_everybody_as_new(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue)
    run = _run(client, acme, year=2026, month=6)
    _computed(client, acme, run["id"])

    report = _variance(client, acme, run["id"])
    assert report["previous_period"] is None
    assert len(report["moved"]) == 1
    row = report["moved"][0]
    assert row["previous_net"] == 0
    assert "First payslip" in row["reasons"][0]


def test_an_unchanged_month_moves_nobody(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue)

    june = _run(client, acme, year=2026, month=6)
    _computed(client, acme, june["id"])
    july = _run(client, acme, year=2026, month=7)
    _computed(client, acme, july["id"])

    report = _variance(client, acme, july["id"])
    assert report["previous_period"] == "2026-06"
    assert report["moved"] == []
    assert report["unchanged"] == 1


def test_a_salary_revision_is_named_as_the_reason(client, tenants):
    """The row that matters most: pay moved, and the report says why without
    anybody opening two payslips side by side."""
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue, gross=5000000)

    june = _run(client, acme, year=2026, month=6)
    _computed(client, acme, june["id"])

    # A raise from July.
    _salary(client, acme, acme.employee.id, catalogue, gross=7000000,
            effective="2026-07-01")
    july = _run(client, acme, year=2026, month=7)
    _computed(client, acme, july["id"])

    report = _variance(client, acme, july["id"])
    assert len(report["moved"]) == 1
    row = report["moved"][0]
    assert row["delta"] > 0
    assert row["current_gross"] > row["previous_gross"]
    assert "Salary structure changed" in row["reasons"]


def test_loss_of_pay_is_named_with_the_days(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue)

    june = _run(client, acme, year=2026, month=6)
    _computed(client, acme, june["id"])

    july = _run(client, acme, year=2026, month=7)
    _computed(client, acme, july["id"], overrides=[
        {"user_id": str(acme.employee.id), "lop_milli_days": 5000}
    ])

    report = _variance(client, acme, july["id"])
    row = report["moved"][0]
    assert row["delta"] < 0
    assert any("Loss of pay" in reason for reason in row["reasons"])


def test_the_threshold_decides_what_counts_as_moved(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue, gross=5000000)

    june = _run(client, acme, year=2026, month=6)
    _computed(client, acme, june["id"])
    _salary(client, acme, acme.employee.id, catalogue, gross=5100000,
            effective="2026-07-01")
    july = _run(client, acme, year=2026, month=7)
    _computed(client, acme, july["id"])

    # A ~2% move is under the default threshold and over a zero one.
    assert _variance(client, acme, july["id"])["moved"] == []
    assert len(_variance(client, acme, july["id"], threshold_percent=0)["moved"]) == 1


def test_variance_is_payroll_only_and_tenant_scoped(client, tenants):
    acme, globex = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue)
    run = _run(client, acme)
    _computed(client, acme, run["id"])

    assert client.get(
        f"/api/v1/payruns/{run['id']}/variance",
        headers=acme.headers(acme.employee_token),
    ).status_code == 403
    assert client.get(
        f"/api/v1/payruns/{run['id']}/variance", headers=globex.headers()
    ).status_code == 404
