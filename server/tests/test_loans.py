"""Loans and advances — the schedule arithmetic and the state machine.

This module tracks money the company is owed, so the tests are weighted towards
the five things that would make a balance wrong:

1. **The schedule sums to the total repayable, exactly**, for every instalment
   count. A rounding gap leaves a balance no instalment covers.
2. **The schedule is built at disbursement and only once.** Rebuilding it after
   a repayment would double the obligation.
3. **Outstanding is derived from the instalments**, so it cannot drift from them.
4. **Sanctioning and disbursing are separate acts**, and nobody sanctions their
   own loan.
5. **A waiver is not a repayment.** It settles the schedule without being
   counted as money recovered.

Amounts are integer paise — ₹10,000.00 is `1000000`.
"""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import select

from app.core.dates import add_months
from app.db.session import SessionLocal
from app.models import InstalmentStatus, Loan, LoanInstalment, User
from app.services import loans as svc


def _request(client, tenant, token=None, **overrides):
    body = {
        "loan_type": "salary_advance",
        "principal": 1000000,
        "instalment_count": 4,
    } | overrides
    response = client.post("/api/v1/loans", json=body, headers=tenant.headers(token))
    return response


def _sanctioned(client, tenant, **overrides):
    loan = _request(client, tenant, tenant.employee_token, **overrides).json()
    return client.post(
        f"/api/v1/loans/{loan['id']}/review",
        json={"status": "approved"},
        headers=tenant.headers(),
    ).json()


def _active(client, tenant, **overrides):
    loan = _sanctioned(client, tenant, **overrides)
    return client.post(
        f"/api/v1/loans/{loan['id']}/disburse",
        json={"disbursed_on": "2026-08-10", "reference": "UTR-DISB-1"},
        headers=tenant.headers(),
    ).json()


# --------------------------------------------------------------------------- #
# 1. The arithmetic
# --------------------------------------------------------------------------- #


def test_a_schedule_always_sums_to_the_total():
    """The failure this prevents: twelve instalments of ₹833.33 against ₹10,000
    losing four paise, leaving a balance no instalment covers."""
    for total in (1, 7, 100, 999_999, 1_000_000, 123_457):
        for count in range(1, 61):
            parts = svc.split_amount(total, count)
            assert sum(parts) == total, (total, count)
            # And within one paise of each other, so the employee sees a
            # predictable figure rather than a lumpy final instalment.
            assert max(parts) - min(parts) <= 1, (total, count)


def test_the_remainder_lands_on_the_earliest_instalments():
    """Not the last one. A final instalment inflated by the remainder is the one
    people query, because it is the one that does not match what they were told."""
    parts = svc.split_amount(1000000, 3)
    assert parts == [333334, 333333, 333333]


def test_interest_is_simple_on_the_original_principal():
    assert svc.total_repayable(1000000, 12, 0) == 1000000
    # 12% per annum for 12 months on ₹10,000 = ₹1,200 interest.
    assert svc.total_repayable(1000000, 12, 1200) == 1120000
    # Half a year is half the interest.
    assert svc.total_repayable(1000000, 6, 1200) == 1060000


def test_month_stepping_survives_a_month_end_anchor():
    """31 December plus one month must be a date, not an exception."""
    schedule = svc.build_schedule(total=900000, count=3, first_due=date(2026, 12, 31))
    assert [row[1] for row in schedule] == [
        date(2026, 12, 1), date(2027, 1, 1), date(2027, 2, 1)
    ]


# --------------------------------------------------------------------------- #
# 2. Requesting
# --------------------------------------------------------------------------- #


def test_an_employee_requests_and_it_starts_as_requested(client, tenants):
    acme, _ = tenants
    body = _request(client, acme, acme.employee_token).json()
    assert body["status"] == "requested"
    assert body["principal"] == 1000000
    assert body["approved_principal"] is None
    assert body["instalments"] == []
    # Before disbursement there is no schedule, so the repayable figure is the
    # projection — a sanctioned loan reading as ₹0 owed would be true and useless.
    assert body["total_repayable"] == 1000000
    assert body["outstanding_amount"] == 0


def test_a_second_open_request_of_the_same_type_is_refused(client, tenants):
    acme, _ = tenants
    assert _request(client, acme, acme.employee_token).status_code == 201
    again = _request(client, acme, acme.employee_token)
    assert again.status_code == 409
    assert again.json()["detail"]["reason"] == "request_pending"

    # A different type is fine — the rule exists to stop a double submit, not to
    # express policy.
    other = _request(client, acme, acme.employee_token, loan_type="travel_advance")
    assert other.status_code == 201


def test_a_disbursed_loan_does_not_block_a_new_request(client, tenants):
    """Taking a second advance while repaying the first is ordinary."""
    acme, _ = tenants
    _active(client, acme)
    assert _request(client, acme, acme.employee_token).status_code == 201


def test_an_employee_cannot_request_for_a_colleague(client, tenants):
    acme, _ = tenants
    response = _request(client, acme, acme.employee_token,
                        user_id=str(acme.owner.id))
    assert response.status_code == 403


def test_an_administrator_files_on_behalf_and_both_are_recorded(client, tenants):
    acme, _ = tenants
    body = _request(client, acme, None, user_id=str(acme.employee.id)).json()
    assert body["user_id"] == str(acme.employee.id)
    assert body["created_by_name"] == acme.owner.full_name


def test_absurd_amounts_and_counts_are_refused(client, tenants):
    acme, _ = tenants
    for overrides in (
        {"principal": 0},
        {"principal": -100},
        {"principal": 999_999_999_999},
        {"instalment_count": 0},
        {"instalment_count": 121},
        {"interest_rate_bps": 10_001},
    ):
        assert _request(client, acme, acme.employee_token,
                        **overrides).status_code == 422, overrides


# --------------------------------------------------------------------------- #
# 3. Sanctioning
# --------------------------------------------------------------------------- #


def test_sanctioning_may_reduce_the_amount_but_not_raise_it(client, tenants):
    acme, _ = tenants
    loan = _request(client, acme, acme.employee_token).json()

    over = client.post(
        f"/api/v1/loans/{loan['id']}/review",
        json={"status": "approved", "approved_principal": 2000000},
        headers=acme.headers(),
    )
    assert over.status_code == 422
    assert over.json()["detail"]["reason"] == "over_request"

    ok = client.post(
        f"/api/v1/loans/{loan['id']}/review",
        json={"status": "approved", "approved_principal": 600000,
              "instalment_count": 6},
        headers=acme.headers(),
    ).json()
    assert ok["status"] == "approved"
    # The request survives intact beside what was actually sanctioned.
    assert ok["principal"] == 1000000
    assert ok["approved_principal"] == 600000
    assert ok["instalment_count"] == 6


def test_a_manager_cannot_sanction_a_loan(client, tenants):
    """Approving a taxi fare is line management; committing the company to lend
    money is not."""
    acme, _ = tenants
    loan = _request(client, acme, acme.employee_token).json()
    with SessionLocal() as db:
        db.get(User, acme.owner.id).role = "manager"
        db.commit()
    response = client.post(
        f"/api/v1/loans/{loan['id']}/review",
        json={"status": "approved"},
        headers=acme.headers(),
    )
    assert response.status_code == 403


def test_nobody_sanctions_their_own_loan(client, tenants):
    acme, _ = tenants
    loan = _request(client, acme).json()  # the owner's own
    response = client.post(
        f"/api/v1/loans/{loan['id']}/review",
        json={"status": "approved"},
        headers=acme.headers(),
    )
    assert response.status_code == 403
    assert response.json()["detail"]["reason"] == "self_review"


def test_a_refusal_needs_a_reason(client, tenants):
    acme, _ = tenants
    loan = _request(client, acme, acme.employee_token).json()
    blank = client.post(
        f"/api/v1/loans/{loan['id']}/review",
        json={"status": "rejected", "review_note": "  "},
        headers=acme.headers(),
    )
    assert blank.status_code == 422
    assert blank.json()["detail"]["reason"] == "note_required"


# --------------------------------------------------------------------------- #
# 4. Disbursing, where the schedule appears
# --------------------------------------------------------------------------- #


def test_disbursing_builds_the_schedule_from_the_month_after(client, tenants):
    """Deducting in the same month the advance was paid out is almost never what
    was agreed."""
    acme, _ = tenants
    loan = _active(client, acme, principal=1000000, instalment_count=4)

    assert loan["status"] == "active"
    assert loan["instalments_total"] == 4
    assert loan["outstanding_amount"] == 1000000
    assert [row["due_on"] for row in loan["instalments"]] == [
        "2026-09-01", "2026-10-01", "2026-11-01", "2026-12-01"
    ]
    assert sum(row["amount"] for row in loan["instalments"]) == 1000000
    assert loan["next_due_on"] == "2026-09-01"


def test_a_loan_cannot_be_disbursed_twice(client, tenants):
    """A second disbursement is either a duplicate payment or a schedule about to
    be rebuilt underneath existing repayments."""
    acme, _ = tenants
    loan = _active(client, acme)
    again = client.post(
        f"/api/v1/loans/{loan['id']}/disburse", json={}, headers=acme.headers()
    )
    assert again.status_code == 409
    assert again.json()["detail"]["reason"] == "not_approved"


def test_an_unsanctioned_loan_cannot_be_disbursed(client, tenants):
    acme, _ = tenants
    loan = _request(client, acme, acme.employee_token).json()
    response = client.post(
        f"/api/v1/loans/{loan['id']}/disburse", json={}, headers=acme.headers()
    )
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "not_approved"


def test_the_disburse_flag_restricts_an_owner(client, tenants):
    acme, _ = tenants
    loan = _sanctioned(client, acme)
    with SessionLocal() as db:
        db.get(User, acme.owner.id).can_disburse_loans = False
        db.commit()
    assert client.post(
        f"/api/v1/loans/{loan['id']}/disburse", json={}, headers=acme.headers()
    ).status_code == 403


def test_interest_appears_in_the_schedule(client, tenants):
    acme, _ = tenants
    loan = _active(client, acme, principal=1000000, instalment_count=12,
                   interest_rate_bps=1200)
    assert loan["total_repayable"] == 1120000
    assert sum(row["amount"] for row in loan["instalments"]) == 1120000
    assert loan["outstanding_amount"] == 1120000


# --------------------------------------------------------------------------- #
# 5. Repayment
# --------------------------------------------------------------------------- #


def test_recording_repayments_reduces_the_outstanding_balance(client, tenants):
    acme, _ = tenants
    loan = _active(client, acme, principal=1000000, instalment_count=4)
    first, second = loan["instalments"][0], loan["instalments"][1]

    after = client.post(
        f"/api/v1/loans/instalments/{first['id']}/repay",
        json={"reference": "PAYROLL-2026-09"},
        headers=acme.headers(),
    ).json()
    assert after["outstanding_amount"] == 750000
    assert after["repaid_amount"] == 250000
    assert after["instalments_paid"] == 1
    assert after["next_due_on"] == "2026-10-01"
    assert after["status"] == "active"

    after = client.post(
        f"/api/v1/loans/instalments/{second['id']}/repay",
        json={}, headers=acme.headers(),
    ).json()
    assert after["outstanding_amount"] == 500000


def test_the_loan_closes_itself_when_nothing_is_pending(client, tenants):
    """Automatic, so nobody has to remember and no report has to guess. "Fully
    repaid but still listed as active" is exactly what an employee disputes."""
    acme, _ = tenants
    loan = _active(client, acme, principal=400000, instalment_count=2)
    for instalment in loan["instalments"]:
        after = client.post(
            f"/api/v1/loans/instalments/{instalment['id']}/repay",
            json={}, headers=acme.headers(),
        ).json()
    assert after["status"] == "closed"
    assert after["outstanding_amount"] == 0
    assert after["closed_on"] is not None


def test_an_instalment_cannot_be_paid_twice(client, tenants):
    acme, _ = tenants
    loan = _active(client, acme)
    first = loan["instalments"][0]
    client.post(f"/api/v1/loans/instalments/{first['id']}/repay", json={},
                headers=acme.headers())
    again = client.post(f"/api/v1/loans/instalments/{first['id']}/repay", json={},
                        headers=acme.headers())
    assert again.status_code == 409
    assert again.json()["detail"]["reason"] == "already_settled"


def test_a_part_payment_is_recorded_as_what_arrived(client, tenants):
    """Forcing it to equal the schedule would mean refusing it or lying."""
    acme, _ = tenants
    loan = _active(client, acme, principal=1000000, instalment_count=4)
    first = loan["instalments"][0]
    after = client.post(
        f"/api/v1/loans/instalments/{first['id']}/repay",
        json={"paid_amount": 100000, "note": "Short this month"},
        headers=acme.headers(),
    ).json()
    paid = next(row for row in after["instalments"] if row["id"] == first["id"])
    assert paid["status"] == "paid"
    assert paid["amount"] == 250000
    # The shortfall is visible rather than the row reopening.
    assert paid["paid_amount"] == 100000
    assert after["repaid_amount"] == 100000


def test_a_waiver_settles_without_counting_as_recovered(client, tenants):
    """Reporting a written-down amount as money recovered would overstate
    collections."""
    acme, _ = tenants
    loan = _active(client, acme, principal=400000, instalment_count=2)
    first = loan["instalments"][0]

    blank = client.post(
        f"/api/v1/loans/instalments/{first['id']}/repay",
        json={"waive": True}, headers=acme.headers(),
    )
    assert blank.status_code == 422
    assert blank.json()["detail"]["reason"] == "note_required"

    after = client.post(
        f"/api/v1/loans/instalments/{first['id']}/repay",
        json={"waive": True, "note": "Hardship"}, headers=acme.headers(),
    ).json()
    waived = next(row for row in after["instalments"] if row["id"] == first["id"])
    assert waived["status"] == "waived"
    assert waived["paid_amount"] is None
    assert after["outstanding_amount"] == 200000
    assert after["repaid_amount"] == 0


def test_an_employee_cannot_record_their_own_repayment(client, tenants):
    acme, _ = tenants
    loan = _active(client, acme)
    first = loan["instalments"][0]
    response = client.post(
        f"/api/v1/loans/instalments/{first['id']}/repay",
        json={}, headers=acme.headers(acme.employee_token),
    )
    assert response.status_code == 403


def test_early_settlement_marks_every_remaining_instalment(client, tenants):
    """A single "settled" flag would leave the schedule half-pending forever and
    every per-month report wrong."""
    acme, _ = tenants
    loan = _active(client, acme, principal=1000000, instalment_count=4)
    client.post(f"/api/v1/loans/instalments/{loan['instalments'][0]['id']}/repay",
                json={}, headers=acme.headers())

    after = client.post(
        f"/api/v1/loans/{loan['id']}/settle",
        json={"reference": "UTR-SETTLE"}, headers=acme.headers(),
    ).json()
    assert after["status"] == "closed"
    assert after["outstanding_amount"] == 0
    assert after["repaid_amount"] == 1000000
    assert all(row["status"] == "paid" for row in after["instalments"])
    assert after["closure_note"] == "Settled early"


def test_settling_a_closed_loan_is_refused(client, tenants):
    acme, _ = tenants
    loan = _active(client, acme, principal=200000, instalment_count=1)
    client.post(f"/api/v1/loans/instalments/{loan['instalments'][0]['id']}/repay",
                json={}, headers=acme.headers())
    response = client.post(f"/api/v1/loans/{loan['id']}/settle", json={},
                           headers=acme.headers())
    assert response.status_code == 409


# --------------------------------------------------------------------------- #
# 6. Write-off and cancellation
# --------------------------------------------------------------------------- #


def test_a_write_off_waives_the_balance_and_is_not_a_closure(client, tenants):
    """Forgiven is not repaid, and the difference matters to accounting and to
    any future lending decision."""
    acme, _ = tenants
    loan = _active(client, acme, principal=1000000, instalment_count=4)
    after = client.post(
        f"/api/v1/loans/{loan['id']}/write-off",
        json={"note": "Employee left without settling"},
        headers=acme.headers(),
    ).json()
    assert after["status"] == "written_off"
    assert after["outstanding_amount"] == 0
    assert after["repaid_amount"] == 0
    # The instalments survive as a record of what was owed.
    assert all(row["status"] == "waived" for row in after["instalments"])


def test_a_write_off_needs_a_reason(client, tenants):
    acme, _ = tenants
    loan = _active(client, acme)
    assert client.post(
        f"/api/v1/loans/{loan['id']}/write-off", json={"note": "   "},
        headers=acme.headers(),
    ).status_code == 422


def test_a_request_can_be_cancelled_but_an_active_loan_cannot(client, tenants):
    """Once disbursed there is a balance, and the way out of a balance is
    repayment or a write-off."""
    acme, _ = tenants
    loan = _request(client, acme, acme.employee_token).json()
    cancelled = client.post(f"/api/v1/loans/{loan['id']}/cancel",
                            headers=acme.headers(acme.employee_token)).json()
    assert cancelled["status"] == "cancelled"

    active = _active(client, acme)
    response = client.post(f"/api/v1/loans/{active['id']}/cancel",
                           headers=acme.headers(acme.employee_token))
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "not_cancellable"


def test_a_sanctioned_but_undisbursed_loan_can_still_be_cancelled(client, tenants):
    """It is still only a promise."""
    acme, _ = tenants
    loan = _sanctioned(client, acme)
    after = client.post(f"/api/v1/loans/{loan['id']}/cancel",
                        headers=acme.headers(acme.employee_token)).json()
    assert after["status"] == "cancelled"


# --------------------------------------------------------------------------- #
# 7. Visibility and the payroll query
# --------------------------------------------------------------------------- #


def test_a_manager_cannot_see_a_reports_loan(client, tenants):
    """Whether a colleague borrowed money is not something line management needs
    to know — the same judgement Core HR makes about a home address."""
    acme, _ = tenants
    loan = _request(client, acme, acme.employee_token).json()
    with SessionLocal() as db:
        manager = db.get(User, acme.owner.id)
        manager.role = "manager"
        db.get(User, acme.employee.id).manager_id = manager.id
        db.commit()

    assert client.get(
        f"/api/v1/loans/{loan['id']}", headers=acme.headers()
    ).status_code == 403
    assert client.get("/api/v1/loans", headers=acme.headers()).json() == []


def test_an_employee_sees_only_their_own(client, tenants):
    acme, _ = tenants
    mine = _request(client, acme, acme.employee_token).json()
    _request(client, acme)  # the owner's own
    rows = client.get("/api/v1/loans", headers=acme.headers(acme.employee_token)).json()
    assert [row["id"] for row in rows] == [mine["id"]]


def test_loans_do_not_cross_tenants(client, tenants):
    acme, globex = tenants
    loan = _active(client, acme)
    assert client.get(
        f"/api/v1/loans/{loan['id']}", headers=globex.headers()
    ).status_code == 404
    assert client.get("/api/v1/loans", headers=globex.headers()).json() == []


def test_the_deduction_schedule_answers_what_payroll_will_ask(client, tenants):
    """Built before payroll exists, on purpose — this is the query a pay run
    makes."""
    acme, _ = tenants
    loan = _active(client, acme, principal=1000000, instalment_count=4)

    rows = client.get(
        "/api/v1/loans/deductions?month=2026-09-15", headers=acme.headers()
    ).json()
    assert len(rows) == 1
    assert rows[0]["amount"] == 250000
    assert rows[0]["sequence"] == 1
    assert rows[0]["instalment_count"] == 4
    assert rows[0]["user_name"] == acme.employee.full_name

    # A paid instalment drops out of the deduction list.
    client.post(f"/api/v1/loans/instalments/{loan['instalments'][0]['id']}/repay",
                json={}, headers=acme.headers())
    assert client.get(
        "/api/v1/loans/deductions?month=2026-09-15", headers=acme.headers()
    ).json() == []


def test_the_deduction_schedule_is_administrator_only(client, tenants):
    acme, _ = tenants
    _active(client, acme)
    assert client.get(
        "/api/v1/loans/deductions", headers=acme.headers(acme.employee_token)
    ).status_code == 403


def test_a_written_off_loan_leaves_the_deduction_schedule(client, tenants):
    acme, _ = tenants
    _active(client, acme, principal=1000000, instalment_count=4)
    loan = client.get("/api/v1/loans", headers=acme.headers()).json()[0]
    client.post(f"/api/v1/loans/{loan['id']}/write-off",
                json={"note": "Left without settling"}, headers=acme.headers())
    assert client.get(
        "/api/v1/loans/deductions?month=2026-09-15", headers=acme.headers()
    ).json() == []


# --------------------------------------------------------------------------- #
# 8. Summary, capabilities, gating
# --------------------------------------------------------------------------- #


def test_the_summary_reports_what_is_owed(client, tenants):
    acme, _ = tenants
    # The detail payload, not the list one: `LoanOut` deliberately carries no
    # instalments — a list of loans does not need every schedule row.
    loan = _active(client, acme, principal=1000000, instalment_count=4)
    client.post(f"/api/v1/loans/instalments/{loan['instalments'][0]['id']}/repay",
                json={}, headers=acme.headers())

    body = client.get("/api/v1/loans/summary", headers=acme.headers()).json()
    assert body["outstanding_amount"] == 750000
    assert body["repaid_amount"] == 250000
    assert body["active_count"] == 1


def test_capability_flags_arrive_resolved(client, tenants):
    acme, _ = tenants
    loan = _request(client, acme, acme.employee_token).json()

    as_employee = client.get(
        f"/api/v1/loans/{loan['id']}", headers=acme.headers(acme.employee_token)
    ).json()
    assert as_employee["can_review"] is False
    assert as_employee["can_cancel"] is True
    assert as_employee["can_disburse"] is False

    as_admin = client.get(f"/api/v1/loans/{loan['id']}", headers=acme.headers()).json()
    assert as_admin["can_review"] is True
    assert as_admin["can_disburse"] is False  # not sanctioned yet


def test_loans_are_gated_like_every_other_module(client, tenants, platform_token):
    acme, _ = tenants
    client.put(
        f"/api/v1/platform/companies/{acme.id}/modules",
        json={"grants": [{"key": "loans", "enabled": False}]},
        headers={"Authorization": f"Bearer {platform_token}"},
    )
    response = client.get("/api/v1/loans", headers=acme.headers())
    assert response.status_code == 402
    assert response.json()["detail"]["module"] == "loans"


def test_the_schedule_cannot_be_duplicated_at_the_database_level(client, tenants):
    """The unique constraint is the backstop for the rule the service enforces:
    a rebuilt schedule must not double a loan's obligations."""
    import sqlalchemy.exc

    acme, _ = tenants
    loan = _active(client, acme, principal=400000, instalment_count=2)
    with SessionLocal() as db:
        db.add(
            LoanInstalment(
                org_id=acme.id, loan_id=__import__("uuid").UUID(loan["id"]),
                sequence=1, due_on=date(2026, 9, 1), amount=200000,
            )
        )
        try:
            db.commit()
            raised = False
        except sqlalchemy.exc.IntegrityError:
            raised = True
    assert raised
