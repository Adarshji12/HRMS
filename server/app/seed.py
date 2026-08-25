"""Create a demo organisation with users, rules and (optionally) sample activity.

    python -m app.seed              # org + users + rules + the HRMS demo tenant
    python -m app.seed --demo-data  # ... plus 7 days of synthetic segments
    python -m app.seed --reset      # drop and recreate every table first

Why the HRMS rows are *not* behind ``--demo-data`` when the activity segments
are: ``--demo-data`` exists because synthetic activity is tens of thousands of
rows nobody wants by default. The whole HRMS demo tenant is around two hundred
rows, and the Phase 0 exit criterion is that a plain ``app.seed`` leaves no new
table empty — so a flag that could leave twenty-six of them empty would defeat
the thing the seed is for. ``verify_hrms_coverage`` enforces that on every run
rather than trusting anyone to eyeball it.
"""

from __future__ import annotations

import argparse
import importlib
import random
import uuid
from datetime import date, datetime, time as dtime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import func, select, text

from app.core.config import settings
from app.core.security import generate_enrollment_key, hash_password
from app.db.base import Base
from app.db.migrations import upgrade_to_head
from app.db.session import SessionLocal, engine
from app.core.plans import BillingCycle, PlanId, SubscriptionStatus, quote_for
from app.models import (
    AccrualType,
    ActivitySegment,
    Asset,
    AssetAssignment,
    AssetCategory,
    AssetStatus,
    AttendanceRecord,
    AttendanceSettings,
    AttendanceStatus,
    ClearanceTaskStatus,
    CompOffCredit,
    Department,
    Designation,
    Device,
    FnfStatus,
    GeofenceEnforcement,
    HalfDaySession,
    HelpdeskCategory,
    HelpdeskComment,
    HelpdeskTicket,
    Holiday,
    LeaveApplication,
    LeaveBalance,
    LeaveSettings,
    LeaveStatus,
    LeaveType,
    OfficeLocation,
    OffboardingFnf,
    OffboardingReason,
    OffboardingRequest,
    OffboardingStatus,
    OffboardingTask,
    OnboardingCategory,
    OnboardingDocument,
    OnboardingInstance,
    OnboardingInstanceStatus,
    OnboardingOwnerRole,
    OnboardingTask,
    OnboardingTaskStatus,
    OnboardingTemplate,
    OnboardingTemplateTask,
    OptionalHolidayOptIn,
    Organization,
    OrgSettings,
    Productivity,
    PunchSource,
    RegularizationRequest,
    RegularizationStatus,
    Role,
    Shift,
    ShiftAssignment,
    Subscription,
    Team,
    TicketPriority,
    TicketStatus,
    User,
    UserStatus,
    WorkSession,
)
from app.models.attendance import MAX_WORKED_MINUTES_PER_DAY
from app.models.leave import HALF_DAY_MILLI_DAYS, MILLI_DAYS_PER_DAY
# Imported from its own module, not re-exported through app.models: __init__
# deliberately exports classes only, so that it does not become the place people
# look for seed content.
from app.models.offboarding import DEFAULT_CLEARANCE_CHECKLIST
from app.services.classifier import Classifier, seed_default_rules

ORG_SLUG = "demo"
ADMIN_EMAIL = "admin@acme.demo"
ADMIN_PASSWORD = "admin12345"

# (email, name, role, department, team, designation)
EMPLOYEES = [
    ("priya.sharma@acme.demo", "Priya Sharma", Role.MANAGER,
     "Engineering", "Platform", "Engineering Manager"),
    ("arjun.mehta@acme.demo", "Arjun Mehta", Role.EMPLOYEE,
     "Engineering", "Platform", "Senior Engineer"),
    ("sara.khan@acme.demo", "Sara Khan", Role.EMPLOYEE,
     "Engineering", "Platform", "Engineer"),
    ("daniel.okoro@acme.demo", "Daniel Okoro", Role.EMPLOYEE,
     "Design", "Product Design", "Product Designer"),
    ("mei.tanaka@acme.demo", "Mei Tanaka", Role.EMPLOYEE,
     "Customer Support", "Support Desk", "Support Specialist"),
]

# (app_name, exec, is_browser, browser, domain, weight)
ACTIVITY_MIX = [
    ("Visual Studio Code", "code.exe", False, None, None, 30),
    ("Google Chrome", "chrome.exe", True, "chrome", "github.com", 12),
    ("Google Chrome", "chrome.exe", True, "chrome", "stackoverflow.com", 8),
    ("Google Chrome", "chrome.exe", True, "chrome", "docs.google.com", 6),
    ("Google Chrome", "chrome.exe", True, "chrome", "mail.google.com", 6),
    ("Google Chrome", "chrome.exe", True, "chrome", "youtube.com", 7),
    ("Microsoft Edge", "msedge.exe", True, "edge", "linkedin.com", 4),
    ("Firefox", "firefox.exe", True, "firefox", "reddit.com", 3),
    ("Slack", "slack.exe", False, None, None, 10),
    ("Microsoft Teams", "teams.exe", False, None, None, 6),
    ("Excel", "excel.exe", False, None, None, 5),
    ("Windows Terminal", "windowsterminal.exe", False, None, None, 8),
]

TITLES = {
    "code.exe": ["main.py - sentinel", "agent/sync.py - sentinel", "README.md - sentinel"],
    "chrome.exe": ["Pull requests - GitHub", "How to ... - Stack Overflow", "Inbox (3)"],
    "slack.exe": ["#engineering | Acme", "#general | Acme"],
    "teams.exe": ["Daily standup | Microsoft Teams"],
    "excel.exe": ["Q3-forecast.xlsx - Excel"],
    "windowsterminal.exe": ["pwsh", "git log"],
    "msedge.exe": ["Feed | LinkedIn"],
    "firefox.exe": ["r/programming"],
}


def ensure_org(db) -> Organization:
    org = db.scalar(select(Organization).where(Organization.slug == ORG_SLUG))
    if org is None:
        org = Organization(
            name="Acme Demo Ltd",
            slug=ORG_SLUG,
            timezone="Asia/Kolkata",
            legal_name="Acme Demo Private Limited",
            contact_email="ops@acme.demo",
            contact_phone="+91 98200 00000",
            city="Mumbai",
            state="Maharashtra",
            country="IN",
            gstin="27AAAAA0000A1Z5",
            industry="Software",
            status="active",
        )
        db.add(org)
        db.flush()
        db.add(OrgSettings(org_id=org.id, screenshot_interval_s=600))
        db.flush()
    return org


def ensure_subscription(db, org: Organization, seats: int = 25) -> Subscription:
    """A paid, active Standard subscription, priced with the real quote maths."""
    existing = db.scalar(select(Subscription).where(Subscription.org_id == org.id))
    if existing is not None:
        return existing

    quote = quote_for(PlanId.STANDARD.value, seats, BillingCycle.ANNUAL.value)
    now = datetime.now(timezone.utc)
    sub = Subscription(
        org_id=org.id,
        plan_id=quote.plan.id,
        billing_cycle=quote.cycle.value,
        seats=quote.employees,
        status=SubscriptionStatus.ACTIVE.value,
        base_amount=quote.base_amount,
        seat_amount=quote.seat_amount,
        tax_amount=quote.tax_amount,
        total_amount=quote.total,
        period_start=now,
        period_end=now.replace(year=now.year + 1),
        activated_at=now,
        notes="Seeded demo subscription",
    )
    db.add(sub)
    db.flush()
    return sub


def ensure_structure(db, org) -> tuple[dict[str, Department], dict[str, Team], dict[str, Designation]]:
    """Departments, teams and designations for the demo company."""
    departments: dict[str, Department] = {}
    for name, code in (("Engineering", "ENG"), ("Design", "DSN"), ("Customer Support", "SUP")):
        existing = db.scalar(
            select(Department).where(Department.org_id == org.id, Department.name == name)
        )
        if existing is None:
            existing = Department(org_id=org.id, name=name, code=code)
            db.add(existing)
            db.flush()
        departments[name] = existing

    teams: dict[str, Team] = {}
    for name, dept in (
        ("Platform", "Engineering"),
        ("Product Design", "Design"),
        ("Support Desk", "Customer Support"),
    ):
        existing = db.scalar(select(Team).where(Team.org_id == org.id, Team.name == name))
        if existing is None:
            existing = Team(org_id=org.id, name=name, department_id=departments[dept].id)
            db.add(existing)
            db.flush()
        teams[name] = existing

    designations: dict[str, Designation] = {}
    for name, level in (
        ("Engineering Manager", 40), ("Senior Engineer", 30), ("Engineer", 20),
        ("Product Designer", 20), ("Support Specialist", 15),
    ):
        existing = db.scalar(
            select(Designation).where(Designation.org_id == org.id, Designation.name == name)
        )
        if existing is None:
            existing = Designation(org_id=org.id, name=name, level=level)
            db.add(existing)
            db.flush()
        designations[name] = existing

    return departments, teams, designations


def ensure_user(db, org, email, name, role, password=None, **placement) -> User:
    user = db.scalar(select(User).where(User.org_id == org.id, User.email == email))
    if user is not None:
        return user
    user = User(
        org_id=org.id,
        email=email,
        full_name=name,
        role=role.value,
        timezone=org.timezone,
        password_hash=hash_password(password) if password else None,
        enrollment_key=generate_enrollment_key(),
        **placement,
    )
    db.add(user)
    db.flush()
    return user


def make_demo_activity(db, org, users: list[User], days: int = 7) -> int:
    """Synthesise plausible workdays so the dashboard has something to render."""
    rng = random.Random(20260810)
    classifier = Classifier.for_org(db, org.id)
    population = [row[:5] for row in ACTIVITY_MIX]
    weights = [row[5] for row in ACTIVITY_MIX]

    # Generate against the organisation's calendar, not the server's. Seeding in
    # UTC leaves "today" empty for every org east of it, because the day the
    # reports query is the org's day.
    tz = ZoneInfo(org.timezone)
    now = datetime.now(tz)
    created = 0
    today = now.date()

    for user in users:
        device = db.scalar(select(Device).where(Device.user_id == user.id))
        if device is None:
            device = Device(
                org_id=org.id,
                user_id=user.id,
                machine_id=f"demo-{user.email}",
                hostname=f"{user.full_name.split()[0].lower()}-pc",
                os="windows",
                os_version="10.0.19045",
                agent_version="0.1.0",
                # Unusable placeholder: demo devices never authenticate.
                token_hash=uuid.uuid4().hex + uuid.uuid4().hex,
                last_seen_at=datetime.now(timezone.utc) - timedelta(seconds=rng.randint(5, 900)),
            )
            db.add(device)
            db.flush()

        for back in range(days):
            day = today - timedelta(days=back)
            if day.weekday() >= 5:  # skip weekends
                continue

            start = datetime.combine(day, dtime(0, 0), tzinfo=tz).replace(
                hour=rng.choice([9, 10]), minute=rng.randint(0, 55)
            ).astimezone(timezone.utc)
            cursor = start
            end_of_day = start + timedelta(hours=rng.uniform(7.0, 9.0))
            # Never invent activity in the future — today is only partly done.
            end_of_day = min(end_of_day, now.astimezone(timezone.utc))
            if end_of_day <= start:
                continue

            db.add(
                WorkSession(
                    org_id=org.id,
                    user_id=user.id,
                    device_id=device.id,
                    started_at=start,
                    ended_at=end_of_day,
                    end_reason="clean",
                    duration_s=int((end_of_day - start).total_seconds()),
                )
            )

            while cursor < end_of_day:
                app_name, app_exec, is_browser, browser, domain = rng.choices(
                    population, weights=weights, k=1
                )[0]
                duration = rng.randint(120, 1800)
                seg_end = min(cursor + timedelta(seconds=duration), end_of_day)
                duration = int((seg_end - cursor).total_seconds())
                if duration < 60:
                    break

                # Idle share: a long segment is more likely to contain a break.
                idle_s = 0
                if rng.random() < 0.22:
                    idle_s = min(duration, rng.randint(60, max(61, duration // 2)))
                is_idle = idle_s > 0 and idle_s >= duration * 0.9

                title = rng.choice(TITLES.get(app_exec, [app_name]))
                db.add(
                    ActivitySegment(
                        org_id=org.id,
                        user_id=user.id,
                        device_id=device.id,
                        client_uid=uuid.uuid4().hex,
                        started_at=cursor,
                        ended_at=seg_end,
                        duration_s=duration,
                        active_s=duration - idle_s,
                        idle_s=idle_s,
                        app_name=app_name,
                        app_exec=app_exec,
                        window_title=title,
                        is_browser=is_browser,
                        browser=browser,
                        url_domain=domain,
                        url_full=f"https://{domain}/" if domain else None,
                        is_idle=is_idle,
                        productivity=(
                            Productivity.NEUTRAL.value
                            if is_idle
                            else classifier.classify(
                                app_exec=app_exec, url_domain=domain, window_title=title
                            )
                        ),
                    )
                )
                created += 1
                cursor = seg_end + timedelta(seconds=rng.randint(0, 60))

    return created


# ---------------------------------------------------------------------------
# HRMS demo tenant
# ---------------------------------------------------------------------------
#
# Everything below fills the twenty-six tables added in Phase 0. It is written
# straight through the ORM because Phase 0 ships models and schemas only —
# there are no services or routers yet to route these writes through, and the
# seed is not the place to grow a shadow copy of the business rules that Phases
# 1-9 will own. Where a rule matters (a rejected regularisation must not touch
# the attendance row, an approved one must), the seed reproduces the *outcome*
# and says so in a comment, so that when the real service lands its output can
# be diffed against this.

#: The model modules that own those tables. The coverage check derives the
#: table list from these rather than from a hand-maintained constant, so a table
#: added in a later phase and never seeded fails this script loudly instead of
#: shipping as a permanently empty tab in the console.
HRMS_MODEL_MODULES = (
    "assets",
    "attendance",
    "helpdesk",
    "leave",
    "offboarding",
    "onboarding",
    "regularization",
)

#: Calendar days of attendance history, ending *yesterday*. Not today: a
#: half-written day is a real state, but it is the one state a reviewer cannot
#: tell apart from a bug, and the nightly job has not classified today yet
#: either — so seeding it would show a status no job had actually decided.
ATTENDANCE_FORTNIGHT_DAYS = 14

# (email, name, role, department, team, designation) for the three people the
# HRMS story needs and the activity demo does not: one mid-onboarding, one
# still pre-boarding, one serving notice.
HRMS_PEOPLE = [
    ("nikhil.rao@acme.demo", "Nikhil Rao", Role.EMPLOYEE,
     "Engineering", "Platform", "Engineer"),
    ("aisha.fernandes@acme.demo", "Aisha Fernandes", Role.EMPLOYEE,
     "Design", "Product Design", "Product Designer"),
    ("rohit.verma@acme.demo", "Rohit Verma", Role.EMPLOYEE,
     "Customer Support", "Support Desk", "Support Specialist"),
]

# (sort_order, category, title, owner_role, due_offset_days, doc_type or None).
# Onboarding has a template table (offboarding deliberately does not — D-017),
# so this is seed content for that table, not a runtime default.
ONBOARDING_TEMPLATE_TASKS = [
    (10, OnboardingCategory.DOCUMENTATION, "Collect signed offer letter and ID proof",
     OnboardingOwnerRole.HR, -3, "id_proof"),
    (20, OnboardingCategory.DOCUMENTATION, "Upload PAN card",
     OnboardingOwnerRole.EMPLOYEE, 1, "pan_card"),
    (30, OnboardingCategory.IT_SETUP, "Issue laptop and access card",
     OnboardingOwnerRole.IT, 0, None),
    (40, OnboardingCategory.IT_SETUP, "Create email, chat and VPN accounts",
     OnboardingOwnerRole.IT, 0, None),
    (50, OnboardingCategory.COMPLIANCE, "Sign NDA and IP assignment",
     OnboardingOwnerRole.HR, 2, "nda"),
    (60, OnboardingCategory.TRAINING, "Security and code-of-conduct induction",
     OnboardingOwnerRole.HR, 3, None),
    (70, OnboardingCategory.OTHER, "Team introduction and buddy assignment",
     OnboardingOwnerRole.MANAGER, 1, None),
]


def _ensure(db, model, defaults: dict | None = None, **keys):
    """Fetch-or-create by natural key, then flush.

    Exactly the select-then-create shape ``ensure_org`` and ``ensure_structure``
    above already use, factored out rather than re-invented: the HRMS section
    fills twenty-six tables, and twenty-six hand-copied guards is how one of
    them quietly loses its guard and the *second* ``python -m app.seed`` starts
    dying on a unique constraint. Defaults are applied on creation only, so
    re-running never silently rewrites a row a developer has been editing by
    hand in the console.
    """
    row = db.scalar(select(model).filter_by(**keys))
    if row is None:
        row = model(**keys, **(defaults or {}))
        db.add(row)
        db.flush()
    return row


def hrms_table_names() -> list[str]:
    """Every table owned by the HRMS model modules, read off the mappers."""
    names: set[str] = set()
    for module_name in HRMS_MODEL_MODULES:
        module = importlib.import_module(f"app.models.{module_name}")
        for value in vars(module).values():
            table = getattr(value, "__table__", None)
            if table is not None and getattr(value, "__module__", None) == module.__name__:
                names.add(table.name)
    return sorted(names)


def verify_hrms_coverage(db, org: Organization) -> dict[str, int]:
    """Count the org's rows in every HRMS table; raise if any table is empty.

    The Phase 0 exit criterion is "demo rows for every new table", and the only
    honest way to hold that is to count. An empty table is not a cosmetic gap:
    it is the state in which nobody notices a model is unreachable until the
    phase that needs it, which is six phases too late.
    """
    counts: dict[str, int] = {}
    for name in hrms_table_names():
        table = Base.metadata.tables[name]
        counts[name] = db.scalar(
            select(func.count()).select_from(table).where(table.c.org_id == org.id)
        )
    empty = [name for name, count in counts.items() if not count]
    if empty:
        raise SystemExit(
            "seed incomplete — no demo rows for: " + ", ".join(empty)
        )
    return counts


def _leave_year(on: date, start_month: int) -> int:
    """Which leave year a date falls in, labelled by the year it opened.

    Computed rather than assumed to be the calendar year, because
    ``leave_settings.leave_year_start_month`` is seeded as April below and a
    seed run in February would otherwise file balances under the leave year
    that has not started yet.
    """
    return on.year if on.month >= start_month else on.year - 1


def _local(day: date, hour: int, minute: int, tz) -> datetime:
    """A wall-clock time on an attendance day, as the UTC instant we store."""
    return datetime.combine(day, dtime(hour, minute), tzinfo=tz).astimezone(timezone.utc)


def ensure_attendance_config(db, org) -> tuple[dict[str, OfficeLocation], dict[str, Shift]]:
    """Offices, the geofence policy row, and the shift catalogue."""
    # Seeded explicitly even though a missing row is legal and means
    # ``flag_only`` (D-009). Seeding it proves the table is reachable and gives
    # the settings page something to render; nothing below reads it back, so a
    # tenant that never creates one still behaves identically.
    _ensure(
        db,
        AttendanceSettings,
        {"geofence_enforcement": GeofenceEnforcement.FLAG_ONLY.value},
        org_id=org.id,
    )

    offices: dict[str, OfficeLocation] = {}
    for name, address, lat, lng, radius, active in (
        ("Mumbai HQ", "Bandra Kurla Complex, Mumbai 400051", 19.0653, 72.8677, 200, True),
        ("Pune Office", "Baner Road, Pune 411045", 18.5596, 73.7797, 150, True),
        # Inactive, not deleted: the attendance rows already flagged against
        # this site keep their meaning and the office can reopen.
        ("Bengaluru Office (closed)", "Koramangala, Bengaluru 560034", 12.9352, 77.6245, 150, False),
    ):
        offices[name] = _ensure(
            db,
            OfficeLocation,
            {"address": address, "lat": lat, "lng": lng, "radius_m": radius, "is_active": active},
            org_id=org.id,
            name=name,
        )

    shifts: dict[str, Shift] = {}
    for name, start, end, grace, half_day, night in (
        ("General", "09:00", "18:00", 15, 240, False),
        ("Early", "07:00", "16:00", 10, 240, False),
        ("Night", "22:00", "06:00", 15, 240, True),
    ):
        shifts[name] = _ensure(
            db,
            Shift,
            {
                "start_time": start,
                "end_time": end,
                "grace_minutes": grace,
                "half_day_threshold_minutes": half_day,
                "is_night_shift": night,
            },
            org_id=org.id,
            name=name,
        )
    return offices, shifts


def ensure_leave_config(db, org, today: date) -> tuple[dict[str, LeaveType], dict[date, Holiday]]:
    """Leave year policy, leave types and the holiday calendar."""
    # April, not the January default, precisely because it is *not* the default:
    # an Indian financial year is the common case for this product's tenants,
    # and a seed that only ever exercises the fallback would let a January
    # assumption hide in the accrual code until a real tenant hit it.
    _ensure(
        db,
        LeaveSettings,
        {"leave_year_start_month": 4, "optional_holiday_quota": 2},
        org_id=org.id,
    )

    leave_types: dict[str, LeaveType] = {}
    for code, name, spec in (
        ("CL", "Casual Leave", dict(
            accrual_type=AccrualType.MONTHLY.value, accrual_rate_milli_days=500,
            max_balance_milli_days=12000, carry_forward_limit_milli_days=0,
            min_notice_days=1, description="Short personal absences. Accrues half a day a month.")),
        ("SL", "Sick Leave", dict(
            accrual_type=AccrualType.YEARLY.value, accrual_rate_milli_days=6000,
            max_balance_milli_days=6000, carry_forward_limit_milli_days=0,
            min_notice_days=0, description="Credited in full at the start of the leave year.")),
        ("EL", "Earned Leave", dict(
            accrual_type=AccrualType.MONTHLY.value, accrual_rate_milli_days=1750,
            max_balance_milli_days=45000, carry_forward_limit_milli_days=15000,
            min_notice_days=7, description="Accrues 1.75 days a month; up to 15 days carry forward.")),
        ("CO", "Comp Off", dict(
            accrual_type=AccrualType.NONE.value, accrual_rate_milli_days=0,
            max_balance_milli_days=0, carry_forward_limit_milli_days=0,
            min_notice_days=0, is_comp_off=True, allow_half_day=False,
            description="Credited by an approver for a worked holiday. Expires in 90 days.")),
        ("LOP", "Loss of Pay", dict(
            accrual_type=AccrualType.NONE.value, accrual_rate_milli_days=0,
            max_balance_milli_days=0, carry_forward_limit_milli_days=0,
            min_notice_days=0, is_paid=False,
            description="Unpaid. Carries no balance, which is why it holds none below.")),
    ):
        leave_types[code] = _ensure(db, LeaveType, {"code": code, **spec}, org_id=org.id, name=name)

    holidays: dict[date, Holiday] = {}
    for holiday_date, name, optional, description in (
        (date(today.year, 1, 26), "Republic Day", False, "National holiday."),
        (date(today.year, 8, 15), "Independence Day", False, "National holiday."),
        (date(today.year, 10, 2), "Gandhi Jayanti", False, "National holiday."),
        # The optional one. Without ``optional_holiday_opt_ins`` (seeded below)
        # this flag would be decorative — the stamping job could only treat the
        # day as off for everyone or for nobody.
        (date(today.year, 12, 25), "Christmas Day", True,
         "Optional holiday — employees opt in from their leave page."),
    ):
        holidays[holiday_date] = _ensure(
            db,
            Holiday,
            {"description": description, "is_optional": optional},
            org_id=org.id,
            holiday_date=holiday_date,
            name=name,
        )
    return leave_types, holidays


def _demo_days(fortnight: list[date], holiday_dates: set[date]) -> dict:
    """Assign the fortnight's working days to the scenarios the demo needs.

    Computed from the run date rather than hard-coded, so the seeded story lands
    on real weekdays whenever this is run — a demo whose "absent day" falls on a
    Sunday teaches a reviewer the wrong thing about the nightly job.
    """
    working = [day for day in fortnight if day.weekday() < 5 and day not in holiday_dates]
    if len(working) < 8:
        raise SystemExit("fortnight has too few working days to seed the demo story")

    founders_day = working[3]
    pool = [day for day in working if day != founders_day]
    # The approved leave has to span consecutive calendar days or the seeded
    # duration would not match the dates anyone reads off the application.
    pair_at = next(
        (i for i in range(len(pool) - 1) if (pool[i + 1] - pool[i]).days == 1), None
    )
    if pair_at is None:
        raise SystemExit("fortnight has no two consecutive working days")
    leave_days = [pool[pair_at], pool[pair_at + 1]]

    rest = [day for day in pool if day not in leave_days]
    return {
        "founders_day": founders_day,
        "leave_days": leave_days,
        "absent_day": rest[0],
        "half_day": rest[1],
        "missed_punch_day": rest[2],
        "client_site_day": rest[3],
        "comp_off_day": rest[4],
    }


def seed_hrms(db, org, admin, employees, departments, teams, designations) -> dict:
    """Fill all twenty-six HRMS tables with one coherent demo tenant."""
    rng = random.Random(20260214)
    tz = ZoneInfo(org.timezone)
    today = datetime.now(tz).date()
    fortnight = [today - timedelta(days=n) for n in range(ATTENDANCE_FORTNIGHT_DAYS, 0, -1)]

    priya, arjun, sara, daniel, mei = employees[:5]
    offices, shifts = ensure_attendance_config(db, org)
    leave_types, holidays = ensure_leave_config(db, org, today)

    demo = _demo_days(fortnight, {h for h in holidays})
    # A company holiday inside the fortnight, so the attendance calendar shows a
    # ``holiday`` row and not only the four fixed national ones, which are
    # months apart and usually miss the window entirely.
    founders = _ensure(
        db,
        Holiday,
        {"description": "Company holiday."},
        org_id=org.id,
        holiday_date=demo["founders_day"],
        name="Founders' Day",
    )
    holidays[founders.holiday_date] = founders
    holiday_dates = set(holidays)

    # --- the three HRMS-only people ----------------------------------------
    #
    # Aisha is pre-boarding: ``status = pending_setup`` describes where she is
    # in the process, and ``is_active = False`` is what actually stops her
    # logging in. Two columns, one gate — D-016. Nikhil has joined, so both
    # flip; his onboarding checklist being unfinished is not an auth question.
    hires: dict[str, User] = {}
    for email, name, role, dept, team, title in HRMS_PEOPLE:
        pre_boarding = email.startswith("aisha")
        hires[email.split(".")[0]] = ensure_user(
            db, org, email, name, role,
            password=None if pre_boarding else "employee12345",
            department_id=departments[dept].id,
            team_id=teams[team].id,
            designation_id=designations[title].id,
            manager_id=priya.id,
            is_active=not pre_boarding,
            status=(UserStatus.PENDING_SETUP if pre_boarding else UserStatus.ACTIVE).value,
        )
    nikhil, aisha, rohit = hires["nikhil"], hires["aisha"], hires["rohit"]

    # --- shift assignments --------------------------------------------------
    #
    # Effective-dated, so the nightly job can still ask which shift someone was
    # on for a date it recomputes (D-011). Mei moved to nights a week ago: her
    # General row is *closed* with an ``effective_to`` and a second row opened
    # the next day, which is the two-row shape the service must produce — a
    # single row edited in place would silently re-date her whole history.
    on_shift = [priya, arjun, sara, daniel, mei, rohit, nikhil]
    for user in on_shift:
        _ensure(
            db, ShiftAssignment,
            {"org_id": org.id, "shift_id": shifts["General"].id,
             "effective_to": fortnight[7] if user is mei else None},
            user_id=user.id, effective_from=fortnight[0],
        )
    night_from = fortnight[8]
    _ensure(
        db, ShiftAssignment,
        {"org_id": org.id, "shift_id": shifts["Night"].id, "effective_to": None},
        user_id=mei.id, effective_from=night_from,
    )
    # The Early shift exists in the catalogue with nobody on it, which is the
    # normal state of a rota the admin has defined but not rolled out.

    # --- attendance ---------------------------------------------------------
    on_leave: dict[tuple[uuid.UUID, date], str] = {
        (sara.id, day): "Casual leave — approved." for day in demo["leave_days"]
    }
    on_leave[(priya.id, demo["comp_off_day"])] = "Comp off — approved."

    punch_source = {
        # The seam to module 1 (spec §1.1): desk staff already run the agent, so
        # their punches come from the work session, not from a form they would
        # have to remember. Field-ish roles punch from the browser.
        mei.id: PunchSource.MOBILE_WEB.value,
        rohit.id: PunchSource.WEB.value,
    }

    attendance: dict[tuple[uuid.UUID, date], AttendanceRecord] = {}
    for user in (priya, arjun, sara, daniel, mei, rohit):
        source = punch_source.get(user.id, PunchSource.AGENT_SESSION.value)
        for day in fortnight:
            if day in holiday_dates:
                fields = {"status": AttendanceStatus.HOLIDAY.value,
                          "note": holidays[day].name}
            elif day.weekday() >= 5:
                fields = {"status": AttendanceStatus.WEEKLY_OFF.value}
            elif (user.id, day) in on_leave:
                fields = {"status": AttendanceStatus.ON_LEAVE.value,
                          "note": on_leave[(user.id, day)]}
            elif user is arjun and day == demo["absent_day"]:
                # No punch, no leave. This is the day the regularisation thread
                # below argues about, and it stays ``absent`` because a
                # rejection must not touch the record.
                fields = {"status": AttendanceStatus.ABSENT.value,
                          "note": "No punch recorded and no leave applied."}
            else:
                night = user is mei and day >= night_from
                start_hour = 22 if night else 9
                check_in = _local(day, start_hour, rng.randint(0, 40), tz)
                half = user is sara and day == demo["half_day"]
                span = timedelta(minutes=rng.randint(230, 250) if half
                                 else rng.randint(505, 585))
                check_out = check_in + span
                # A missed evening punch is the single most common real state in
                # any attendance system, so one employee has one — left NULL
                # here and filled in by the approved regularisation below.
                missed = user is daniel and day == demo["missed_punch_day"]
                off_site = user is daniel and day == demo["client_site_day"]
                worked = 0 if missed else max(
                    0, min(int(span.total_seconds() // 60) - (0 if half else 60),
                           MAX_WORKED_MINUTES_PER_DAY)
                )
                office = offices["Mumbai HQ"]
                fields = {
                    "check_in_at": check_in,
                    "check_out_at": None if missed else check_out,
                    "check_in_lat": office.lat, "check_in_lng": office.lng,
                    "check_out_lat": None if missed else office.lat,
                    "check_out_lng": None if missed else office.lng,
                    "is_geo_verified_in": not off_site,
                    "is_geo_verified_out": not (missed or off_site),
                    "check_in_distance_m": rng.randint(1200, 1800) if off_site
                    else rng.randint(15, 180),
                    "check_out_distance_m": None if missed else (
                        rng.randint(1200, 1800) if off_site else rng.randint(15, 180)
                    ),
                    "check_in_ip": "203.0.113.24",
                    "check_out_ip": None if missed else "203.0.113.24",
                    "check_in_source": source,
                    "check_out_source": None if missed else source,
                    "status": (AttendanceStatus.HALF_DAY if half
                               else AttendanceStatus.PRESENT).value,
                    "worked_minutes": worked,
                    "note": "Client site visit — punched outside every geofence."
                    if off_site else ("Left early — half day." if half else None),
                }
            attendance[(user.id, day)] = _ensure(
                db, AttendanceRecord, {"org_id": org.id, **fields},
                user_id=user.id, date=day,
            )

    # --- regularization -----------------------------------------------------
    #
    # Two rows for the same (org, user, date): one rejected, one pending. That
    # pair is the whole point of D-005's partial unique index — a plain unique
    # constraint would forbid re-filing after a rejection, and this seed would
    # fail on the second insert instead of demonstrating the fix.
    _ensure(
        db, RegularizationRequest,
        {"org_id": org.id,
         "requested_check_in": _local(demo["absent_day"], 9, 5, tz),
         "requested_check_out": _local(demo["absent_day"], 18, 20, tz),
         "reason": "Was at the client office all day; my phone had no signal to punch.",
         "created_by_user_id": arjun.id,
         "reviewed_by_user_id": priya.id,
         "reviewed_at": _local(demo["absent_day"] + timedelta(days=1), 11, 0, tz),
         "review_note": "No client visit on the rota for this date. Re-file with the visit approval."},
        user_id=arjun.id, date=demo["absent_day"],
        status=RegularizationStatus.REJECTED.value,
    )
    _ensure(
        db, RegularizationRequest,
        {"org_id": org.id,
         "requested_check_in": _local(demo["absent_day"], 9, 5, tz),
         "requested_check_out": _local(demo["absent_day"], 18, 20, tz),
         "reason": "Re-filed with Priya's written approval for the client visit attached.",
         "created_by_user_id": arjun.id},
        user_id=arjun.id, date=demo["absent_day"],
        status=RegularizationStatus.PENDING.value,
    )
    approved_reg = _ensure(
        db, RegularizationRequest,
        {"org_id": org.id,
         "requested_check_out": _local(demo["missed_punch_day"], 18, 45, tz),
         "reason": "Laptop battery died before I could punch out.",
         "created_by_user_id": daniel.id,
         "reviewed_by_user_id": priya.id,
         "reviewed_at": _local(demo["missed_punch_day"] + timedelta(days=1), 10, 15, tz),
         "review_note": "Confirmed against the building door log."},
        user_id=daniel.id, date=demo["missed_punch_day"],
        status=RegularizationStatus.APPROVED.value,
    )
    # Only the approval path writes back — and it stamps the source, so a report
    # can always tell a measured punch from a human decision (D-007). Guarded on
    # the pointer being unset so a re-run does not re-apply it.
    corrected = attendance[(daniel.id, demo["missed_punch_day"])]
    if corrected.regularization_id is None:
        corrected.check_out_at = approved_reg.requested_check_out
        corrected.check_out_source = PunchSource.REGULARIZED.value
        corrected.regularization_id = approved_reg.id
        corrected.note = "Check-out restored by an approved regularisation."
        corrected.worked_minutes = min(
            int((corrected.check_out_at - corrected.check_in_at).total_seconds() // 60) - 60,
            MAX_WORKED_MINUTES_PER_DAY,
        )
        db.flush()

    # --- leave ledger -------------------------------------------------------
    leave_year = _leave_year(today, 4)
    # Balances carry the whole leave year; most of what ``used_milli_days``
    # records happened before this fortnight. Only Sara's casual leave and
    # Priya's comp-off appear in both the balance and the applications below.
    balance_plan = {
        "CL": dict(opening_milli_days=2000, accrued_milli_days=4000,
                   used_milli_days=0, adjusted_milli_days=0),
        "SL": dict(opening_milli_days=1000, accrued_milli_days=6000,
                   used_milli_days=2000, adjusted_milli_days=0),
        # The row a reviewer should open: all four components non-zero, so the
        # difference between "entitled" and "balance" is visible rather than
        # theoretical. The negative adjustment is the carry-forward cap being
        # applied at the year roll-over, which is the commonest real one.
        "EL": dict(opening_milli_days=15000, accrued_milli_days=14000,
                   used_milli_days=3000, adjusted_milli_days=-1000,
                   adjusted_reason="Carry-forward capped at 15 days at the leave-year "
                                   "roll-over; the excess was written off here.",
                   adjusted_by_user_id=admin.id),
    }
    for user in (priya, arjun, sara, daniel, mei, rohit):
        for code, plan in balance_plan.items():
            fields = dict(plan)
            if fields.get("adjusted_reason"):
                fields["adjusted_at"] = datetime.now(timezone.utc)
            if user is sara and code == "CL":
                fields["used_milli_days"] = 2000  # the approved application below
            _ensure(
                db, LeaveBalance, {"org_id": org.id, **fields},
                user_id=user.id, leave_type_id=leave_types[code].id, year=leave_year,
            )
    # Comp-off balances mirror the credits below rather than any accrual rule —
    # the type accrues nothing; an approver creates the credit.
    for user, accrued, used, written_off in (
        (priya, 2000, 1000, 0), (arjun, 1000, 0, 0), (sara, 1000, 0, -1000),
    ):
        _ensure(
            db, LeaveBalance,
            {"org_id": org.id, "accrued_milli_days": accrued, "used_milli_days": used,
             "adjusted_milli_days": written_off,
             "adjusted_reason": "Comp-off credit expired unused." if written_off else None,
             "adjusted_by_user_id": admin.id if written_off else None,
             "adjusted_at": datetime.now(timezone.utc) if written_off else None},
            user_id=user.id, leave_type_id=leave_types["CO"].id, year=leave_year,
        )

    now = datetime.now(timezone.utc)
    applications: dict[str, LeaveApplication] = {}
    applications["sara_cl"] = _ensure(
        db, LeaveApplication,
        {"org_id": org.id, "end_date": demo["leave_days"][1],
         "duration_milli_days": 2 * MILLI_DAYS_PER_DAY,
         "reason": "Family function out of town.",
         "status": LeaveStatus.APPROVED.value,
         "applied_at": _local(demo["leave_days"][0] - timedelta(days=6), 10, 0, tz),
         "reviewed_at": _local(demo["leave_days"][0] - timedelta(days=5), 9, 30, tz),
         "reviewed_by_user_id": priya.id,
         # Stamped in the same transaction as the debit (D-013). Its presence is
         # what makes a double-clicked approval a no-op instead of a double debit.
         "debited_at": _local(demo["leave_days"][0] - timedelta(days=5), 9, 30, tz)},
        user_id=sara.id, leave_type_id=leave_types["CL"].id,
        start_date=demo["leave_days"][0],
    )
    applications["mei_sl"] = _ensure(
        db, LeaveApplication,
        {"org_id": org.id, "end_date": today + timedelta(days=3),
         "is_half_day": True, "half_day_session": HalfDaySession.FIRST_HALF.value,
         "duration_milli_days": HALF_DAY_MILLI_DAYS,
         "reason": "Dentist appointment in the morning.",
         "status": LeaveStatus.PENDING.value, "applied_at": now},
        user_id=mei.id, leave_type_id=leave_types["SL"].id,
        start_date=today + timedelta(days=3),
    )
    applications["daniel_el"] = _ensure(
        db, LeaveApplication,
        {"org_id": org.id, "end_date": today + timedelta(days=23),
         "duration_milli_days": 3 * MILLI_DAYS_PER_DAY,
         "reason": "Long weekend away.",
         "status": LeaveStatus.REJECTED.value,
         "applied_at": now - timedelta(days=2),
         "reviewed_at": now - timedelta(days=1),
         "reviewed_by_user_id": priya.id,
         "review_note": "Two of the team are already off that week — please move it a fortnight."},
        user_id=daniel.id, leave_type_id=leave_types["EL"].id,
        start_date=today + timedelta(days=21),
    )
    applications["priya_co"] = _ensure(
        db, LeaveApplication,
        {"org_id": org.id, "end_date": demo["comp_off_day"],
         "duration_milli_days": MILLI_DAYS_PER_DAY,
         "reason": "Comp off for the release weekend.",
         "status": LeaveStatus.APPROVED.value,
         "applied_at": _local(demo["comp_off_day"] - timedelta(days=4), 15, 0, tz),
         "reviewed_at": _local(demo["comp_off_day"] - timedelta(days=3), 9, 0, tz),
         "reviewed_by_user_id": admin.id,
         "debited_at": _local(demo["comp_off_day"] - timedelta(days=3), 9, 0, tz)},
        user_id=priya.id, leave_type_id=leave_types["CO"].id,
        start_date=demo["comp_off_day"],
    )
    # Withdrawn while still pending, so there is nothing to credit back and
    # ``debited_at`` correctly stays NULL — the state ``leave_cancelled`` (D-013)
    # has to be able to render.
    applications["arjun_el"] = _ensure(
        db, LeaveApplication,
        {"org_id": org.id, "end_date": today + timedelta(days=36),
         "duration_milli_days": 2 * MILLI_DAYS_PER_DAY,
         "reason": "Short holiday — plans changed.",
         "status": LeaveStatus.CANCELLED.value,
         "applied_at": now - timedelta(days=5), "cancelled_at": now - timedelta(days=4)},
        user_id=arjun.id, leave_type_id=leave_types["EL"].id,
        start_date=today + timedelta(days=35),
    )

    # Comp-off credits: one spent, one live, one expired — the three states the
    # expiry job has to be able to leave a credit in.
    _ensure(
        db, CompOffCredit,
        {"org_id": org.id, "reason": "Worked the release weekend.",
         "credit_milli_days": MILLI_DAYS_PER_DAY,
         "expires_at": demo["comp_off_day"] - timedelta(days=20) + timedelta(days=90),
         "used_in_application_id": applications["priya_co"].id,
         "granted_by_user_id": admin.id},
        user_id=priya.id, earned_date=demo["comp_off_day"] - timedelta(days=20),
    )
    _ensure(
        db, CompOffCredit,
        {"org_id": org.id, "reason": "Production incident, Saturday.",
         "credit_milli_days": MILLI_DAYS_PER_DAY,
         "expires_at": today + timedelta(days=83), "granted_by_user_id": priya.id},
        user_id=arjun.id, earned_date=today - timedelta(days=7),
    )
    _ensure(
        db, CompOffCredit,
        {"org_id": org.id, "reason": "Customer migration weekend.",
         "credit_milli_days": MILLI_DAYS_PER_DAY,
         "expires_at": today - timedelta(days=10),
         "expired_at": datetime.combine(today - timedelta(days=10), dtime(0, 0),
                                        tzinfo=tz).astimezone(timezone.utc),
         "granted_by_user_id": priya.id},
        user_id=sara.id, earned_date=today - timedelta(days=100),
    )

    christmas = holidays[date(today.year, 12, 25)]
    for user in (daniel, mei):
        _ensure(db, OptionalHolidayOptIn, {"org_id": org.id},
                user_id=user.id, holiday_id=christmas.id)

    # --- onboarding ---------------------------------------------------------
    template = _ensure(
        db, OnboardingTemplate,
        {"description": "Standard checklist for engineering and design hires.",
         "department_id": departments["Engineering"].id},
        org_id=org.id, name="Standard New Joiner",
    )
    template_tasks: list[OnboardingTemplateTask] = []
    for sort_order, category, title, owner, offset, doc_type in ONBOARDING_TEMPLATE_TASKS:
        template_tasks.append(_ensure(
            db, OnboardingTemplateTask,
            {"org_id": org.id, "category": category.value, "owner_role": owner.value,
             "due_offset_days": offset, "sort_order": sort_order,
             "requires_document": doc_type is not None, "doc_type": doc_type},
            template_id=template.id, title=title,
        ))

    # Two instances: one mid-checklist, one still pre-boarding. The instance
    # snapshots ``template_name`` because renaming the template later must not
    # rewrite what a completed hire was actually onboarded against.
    joined = today - timedelta(days=5)
    instance_live = _ensure(
        db, OnboardingInstance,
        {"org_id": org.id, "template_id": template.id, "template_name": template.name,
         "joining_date": joined, "status": OnboardingInstanceStatus.IN_PROGRESS.value,
         "started_at": _local(joined, 9, 30, tz),
         "notes": "Laptop issued on day one; NDA still with legal."},
        user_id=nikhil.id,
    )
    instance_pending = _ensure(
        db, OnboardingInstance,
        {"org_id": org.id, "template_id": template.id, "template_name": template.name,
         "joining_date": today + timedelta(days=12),
         "status": OnboardingInstanceStatus.PENDING_SETUP.value,
         "notes": "Offer accepted; pre-boarding paperwork sent."},
        user_id=aisha.id,
    )

    # Which of the template's tasks the live instance has finished. Mid-checklist
    # on purpose: a fully done and a fully pending instance both hide the state
    # the pipeline view exists to show.
    done_titles = {
        "Collect signed offer letter and ID proof",
        "Upload PAN card",
        "Issue laptop and access card",
        "Create email, chat and VPN accounts",
        "Team introduction and buddy assignment",
    }
    in_progress_titles = {"Sign NDA and IP assignment"}
    pan_task: OnboardingTask | None = None
    for instance, owner_user, live in (
        (instance_live, nikhil, True), (instance_pending, aisha, False)
    ):
        for source_task in template_tasks:
            if live and source_task.title in done_titles:
                state = OnboardingTaskStatus.DONE.value
            elif live and source_task.title in in_progress_titles:
                state = OnboardingTaskStatus.IN_PROGRESS.value
            else:
                state = OnboardingTaskStatus.PENDING.value
            assignee = owner_user if source_task.owner_role == OnboardingOwnerRole.EMPLOYEE.value else admin
            task = _ensure(
                db, OnboardingTask,
                {"org_id": org.id, "source_template_task_id": source_task.id,
                 "category": source_task.category, "owner_role": source_task.owner_role,
                 "sort_order": source_task.sort_order,
                 "requires_document": source_task.requires_document,
                 "doc_type": source_task.doc_type,
                 "due_date": instance.joining_date + timedelta(days=source_task.due_offset_days),
                 "assignee_user_id": assignee.id,
                 "status": state,
                 "completed_by": admin.id if state == OnboardingTaskStatus.DONE.value else None,
                 "completed_at": _local(joined, 17, 0, tz)
                 if state == OnboardingTaskStatus.DONE.value else None},
                instance_id=instance.id, title=source_task.title,
            )
            if live and source_task.doc_type == "pan_card":
                pan_task = task

    # The bytes are deliberately absent. ``storage_key`` is minted and parsed
    # only by services/storage.py, and seeding a real object would leave a file
    # on disk that ``--reset`` cannot drop — the same call ``Device.token_hash``
    # already makes with an unusable placeholder. The row is what Phase 6 needs
    # to render; the download is a Phase 6 code path.
    _ensure(
        db, OnboardingDocument,
        {"org_id": org.id, "task_id": pan_task.id if pan_task else None,
         "storage_key": f"seed-placeholder/{uuid.uuid4().hex}",
         "file_name": "nikhil-pan.pdf", "content_type": "application/pdf",
         "file_size": 84_213, "uploaded_by": nikhil.id, "verified_by": admin.id,
         "verified_at": _local(joined + timedelta(days=1), 12, 0, tz),
         "verification_note": "Name and number match the offer letter."},
        instance_id=instance_live.id, doc_type="pan_card",
    )

    # --- offboarding --------------------------------------------------------
    #
    # A cancelled request and an open one for the same person. That pair is what
    # proves ``uq_offboarding_requests_open_per_user`` is partial: a plain
    # unique index would make a withdrawn resignation permanently block the real
    # one, and this seed would fail on the second insert.
    _ensure(
        db, OffboardingRequest,
        {"org_id": org.id, "initiated_by": rohit.id,
         "reason": OffboardingReason.RESIGNATION.value,
         "reason_note": "Withdrawn after a counter-offer.",
         "last_working_day": today - timedelta(days=170),
         "cancelled_at": _local(today - timedelta(days=190), 16, 0, tz),
         "cancellation_reason": "Employee withdrew the resignation."},
        user_id=rohit.id, notice_date=today - timedelta(days=200),
        status=OffboardingStatus.CANCELLED.value,
    )
    last_day = today + timedelta(days=20)
    exit_request = _ensure(
        db, OffboardingRequest,
        {"org_id": org.id, "initiated_by": rohit.id,
         "reason": OffboardingReason.RESIGNATION.value,
         "reason_note": "Moving to a role closer to home.",
         "last_working_day": last_day},
        user_id=rohit.id, notice_date=today - timedelta(days=10),
        status=OffboardingStatus.IN_PROGRESS.value,
    )
    # Copied from the module constant, exactly as Phase 7 will: offboarding has
    # no template table on purpose (D-017), and ``sort_order`` — not
    # ``order_index`` — is the standardised name (D-015).
    role_owner = {"employee": rohit, "manager": priya, "hr": admin, "it": admin}
    for index, item in enumerate(DEFAULT_CLEARANCE_CHECKLIST):
        first = index == 0
        _ensure(
            db, OffboardingTask,
            {"org_id": org.id, "category": item["category"],
             "owner_role": item["owner_role"],
             "assignee_user_id": role_owner[item["owner_role"]].id,
             "is_mandatory": item["is_mandatory"],
             "due_offset_days": item["due_offset_days"],
             "due_on": last_day + timedelta(days=item["due_offset_days"]),
             "sort_order": (index + 1) * 10,
             "status": (ClearanceTaskStatus.DONE if first
                        else ClearanceTaskStatus.PENDING).value,
             "completed_by": rohit.id if first else None,
             "completed_at": _local(today - timedelta(days=2), 18, 0, tz) if first else None,
             "notes": "Handover doc in the team wiki." if first else None},
            request_id=exit_request.id, title=item["title"],
        )
    # Money in paise, integers, and the three columns are stored rather than
    # derived because the spec says F&F is calculated outside this system — this
    # table records what finance decided, not what we recomputed.
    _ensure(
        db, OffboardingFnf,
        {"org_id": org.id, "gross_dues_paise": 12_50_000, "deductions_paise": 1_50_000,
         "net_payable_paise": 11_00_000, "status": FnfStatus.DRAFT.value,
         "prepared_by": admin.id,
         "notes": "Unused earned leave encashment less notice-period shortfall. "
                  "Awaiting finance sign-off."},
        request_id=exit_request.id,
    )

    # --- assets -------------------------------------------------------------
    laptop = _ensure(
        db, Asset,
        {"category": AssetCategory.LAPTOP.value, "serial_number": "5CD1234ABC",
         "purchase_date": today - timedelta(days=420),
         "status": AssetStatus.ASSIGNED.value},
        org_id=org.id, asset_tag="LAP-1042",
    )
    _ensure(
        db, Asset,
        {"category": AssetCategory.MONITOR.value, "serial_number": "MON77219",
         "purchase_date": today - timedelta(days=300),
         "status": AssetStatus.AVAILABLE.value},
        org_id=org.id, asset_tag="MON-2210",
    )
    sim = _ensure(
        db, Asset,
        {"category": AssetCategory.SIM.value, "serial_number": "8991000012345678",
         "purchase_date": today - timedelta(days=200),
         "status": AssetStatus.ASSIGNED.value},
        org_id=org.id, asset_tag="SIM-3301",
    )
    _ensure(
        db, Asset,
        {"category": AssetCategory.ID_CARD.value, "serial_number": None,
         "purchase_date": today - timedelta(days=900),
         "status": AssetStatus.RETIRED.value},
        org_id=org.id, asset_tag="IDC-0007",
    )
    # One closed custody period and one open one on the *same* asset. This is
    # the pair ``uq_asset_assignments_open_per_asset`` has to permit: a plain
    # unique index on asset_id would brick re-issuing a laptop forever, and this
    # insert is where that would show up.
    _ensure(
        db, AssetAssignment,
        {"org_id": org.id, "user_id": sara.id,
         "returned_at": _local(today - timedelta(days=60), 17, 30, tz),
         "assigned_condition_note": "New, sealed box.",
         "returned_condition_note": "Scratch on the lid; battery health 82%."},
        asset_id=laptop.id, assigned_at=_local(today - timedelta(days=400), 10, 0, tz),
    )
    _ensure(
        db, AssetAssignment,
        {"org_id": org.id, "user_id": arjun.id, "returned_at": None,
         "assigned_condition_note": "Reimaged, screen protector fitted."},
        asset_id=laptop.id, assigned_at=_local(today - timedelta(days=58), 11, 0, tz),
    )
    _ensure(
        db, AssetAssignment,
        {"org_id": org.id, "user_id": rohit.id, "returned_at": None,
         "assigned_condition_note": "Corporate SIM, 30 GB plan."},
        asset_id=sim.id, assigned_at=_local(today - timedelta(days=150), 12, 0, tz),
    )

    # --- helpdesk -----------------------------------------------------------
    categories: dict[str, HelpdeskCategory] = {}
    for name, description, assignee_role, active in (
        ("IT Support", "Hardware, accounts and access.", Role.ADMIN.value, True),
        ("HR Policy", "Leave, attendance and policy questions.", Role.ADMIN.value, True),
        ("Payroll", "Salary, reimbursements and F&F.", Role.OWNER.value, True),
        ("Facilities", "Retired — raise these with the building desk.", None, False),
    ):
        categories[name] = _ensure(
            db, HelpdeskCategory,
            {"description": description, "default_assignee_role": assignee_role,
             "is_active": active},
            org_id=org.id, name=name,
        )

    ticket = _ensure(
        db, HelpdeskTicket,
        {"raised_by": sara.id, "assigned_to": admin.id,
         "category_id": categories["IT Support"].id,
         "description": "The fan spins up constantly and the machine is hot to the touch.",
         "status": TicketStatus.IN_PROGRESS.value, "priority": TicketPriority.NORMAL.value},
        org_id=org.id, subject="Laptop fan running constantly",
    )
    # Both kinds of comment on one ticket, which is the only way the visibility
    # split is demonstrable at all: the employee-facing schema types
    # ``is_internal`` as Literal[False] (D-019), so this internal row must raise
    # rather than serialise if anyone ever points the wrong schema at it.
    _ensure(
        db, HelpdeskComment,
        {"org_id": org.id, "author_id": sara.id, "is_internal": False},
        ticket_id=ticket.id, body="It started after the last firmware update.",
    )
    _ensure(
        db, HelpdeskComment,
        {"org_id": org.id, "author_id": admin.id, "is_internal": False},
        ticket_id=ticket.id,
        body="Thanks — we have a loaner ready. Bring it to the IT desk any time this week.",
    )
    _ensure(
        db, HelpdeskComment,
        {"org_id": org.id, "author_id": admin.id, "is_internal": True},
        ticket_id=ticket.id,
        body="Out of warranty since March. Quote the vendor before promising a replacement.",
    )
    # A cross-module deep link with no foreign key, which is the point of D-019:
    # helpdesk must be able to reference a rejected regularisation without
    # depending on that module, and a dangling ref renders as "linked item
    # unavailable" rather than a 500.
    rejected_reg = db.scalar(
        select(RegularizationRequest).where(
            RegularizationRequest.user_id == arjun.id,
            RegularizationRequest.date == demo["absent_day"],
            RegularizationRequest.status == RegularizationStatus.REJECTED.value,
        )
    )
    _ensure(
        db, HelpdeskTicket,
        {"raised_by": arjun.id, "category_id": categories["HR Policy"].id,
         "description": "The client visit was approved over chat before the trip. "
                        "Attaching the approval — please review the rejection.",
         "status": TicketStatus.OPEN.value, "priority": TicketPriority.HIGH.value,
         "source_module": "regularization",
         "source_ref": rejected_reg.id if rejected_reg else None},
        org_id=org.id,
        subject="Dispute: regularisation rejected for the client-site day",
    )
    _ensure(
        db, HelpdeskTicket,
        {"raised_by": mei.id, "assigned_to": admin.id,
         "category_id": categories["Payroll"].id,
         "description": "I am not receiving the monthly payslip email.",
         "status": TicketStatus.CLOSED.value, "priority": TicketPriority.LOW.value,
         "resolved_at": now - timedelta(days=6), "closed_at": now - timedelta(days=4)},
        org_id=org.id, subject="Not on the payslip mailing list",
    )

    return {
        "hires": [nikhil, aisha, rohit],
        "fortnight": (fortnight[0], fortnight[-1]),
        "leave_year": leave_year,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed the Sentinel demo organisation")
    parser.add_argument("--demo-data", action="store_true", help="generate sample activity")
    parser.add_argument("--days", type=int, default=7, help="days of sample activity")
    parser.add_argument("--reset", action="store_true", help="drop all tables first")
    args = parser.parse_args()

    if args.reset:
        Base.metadata.drop_all(bind=engine)
        # drop_all does not know about alembic_version (it is not on the
        # metadata), so without this the next upgrade would think the schema is
        # already current and create nothing.
        with engine.begin() as connection:
            connection.execute(text("DROP TABLE IF EXISTS alembic_version"))

    revision = upgrade_to_head()
    print(f"Schema       : {revision}")

    with SessionLocal() as db:
        org = ensure_org(db)
        subscription = ensure_subscription(db, org)
        departments, teams, designations = ensure_structure(db, org)
        admin = ensure_user(db, org, ADMIN_EMAIL, "Demo Administrator", Role.OWNER, ADMIN_PASSWORD)

        employees = [
            ensure_user(
                db, org, email, name, role, password="employee12345",
                department_id=departments[dept].id,
                team_id=teams[team].id,
                designation_id=designations[title].id,
            )
            for email, name, role, dept, team, title in EMPLOYEES
        ]

        # Reporting lines: the manager reports to the owner, everyone else to
        # the manager. This is what makes the hierarchy endpoints and manager
        # scoping demonstrable rather than a flat list.
        manager = employees[0]
        manager.manager_id = admin.id
        teams["Platform"].manager_user_id = manager.id
        departments["Engineering"].head_user_id = manager.id
        for employee in employees[1:]:
            employee.manager_id = manager.id

        added_rules = seed_default_rules(db, org.id)
        db.commit()

        hrms = seed_hrms(db, org, admin, employees, departments, teams, designations)
        db.commit()
        # Counted, never eyeballed: the Phase 0 exit criterion is that no new
        # table is left empty, and this is the only statement that can hold it.
        coverage = verify_hrms_coverage(db, org)

        segments = 0
        if args.demo_data:
            segments = make_demo_activity(db, org, employees, days=args.days)
            db.commit()

        print(f"\nOrganisation : {org.name}  ({org.timezone})")
        print(f"Subdomain    : {org.slug}.{settings.base_domain}")
        print(
            f"Subscription : {subscription.plan_id} / {subscription.seats} seats / "
            f"{subscription.status}  =  Rs {subscription.total_amount / 100:,.2f} incl. GST"
        )
        print(f"Rules added  : {added_rules}")
        if args.demo_data:
            print(f"Segments     : {segments}")
        print(
            f"Attendance   : {hrms['fortnight'][0]} .. {hrms['fortnight'][1]}  "
            f"(leave year {hrms['leave_year']})"
        )

        print(f"\nHRMS demo rows ({len(coverage)} tables)")
        print("-" * 52)
        for name, count in coverage.items():
            print(f"  {name:<32} {count:>5}")

        print(f"\nDashboard login: {admin.email} / {ADMIN_PASSWORD}")
        print("\nAgent enrollment keys")
        print("-" * 52)
        for u in [*employees, *hrms["hires"]]:
            print(f"  {u.full_name:<18} {u.enrollment_key}")
        print()


if __name__ == "__main__":
    main()
