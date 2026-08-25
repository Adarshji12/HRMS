"""The merge-field engine: `{{employee.full_name}}` becomes a name.

**Why this is thirty lines of regex and not Jinja2.** The person authoring a
template here is a *customer*, not us. Jinja2 hands that author expressions,
attribute traversal, filters and inheritance inside a multi-tenant process;
``SandboxedEnvironment`` narrows it, but the sandbox is a moving target that has
been escaped before and it is a large surface to defend for a feature whose
entire job is substituting a name and a date. This engine has no expressions, no
traversal and no evaluation: a token either names something in an explicit
registry or it does not, and one that does not is reported rather than rendered.

**What is deliberately absent from the registry.** PAN, Aadhaar and bank
account. Core HR encrypts those at rest, masks them in every response, and makes
revealing one an audited POST. A merge field would drive a lorry through all of
that — one template, and every letter issued from it carries a decrypted
identity number with no audit row anywhere. If a future salary certificate
genuinely needs a PAN, it gets a dedicated field with a dedicated audit row, not
a token anybody can paste into any template.

**Unknown tokens do not silently vanish.** ``render`` returns the text *and* the
tokens it could not resolve. An offer letter that quietly reads "Dear ," because
somebody typed ``{{employee.name}}`` is worse than one that refuses to issue.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import date

from sqlalchemy.orm import Session

from app.models import (
    Department,
    Designation,
    EmployeeProfile,
    Organization,
    Team,
    User,
)

#: ``{{ employee.full_name }}`` — whitespace tolerated, since people type it.
#: Dots only, no brackets or calls: the grammar itself refuses anything that
#: would need evaluating.
TOKEN = re.compile(r"\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\s*\}\}")


@dataclass(frozen=True)
class MergeField:
    token: str
    label: str
    #: Shown in the template editor's field picker, so an author can tell
    #: ``employee.manager`` from ``employee.designation`` without guessing.
    example: str
    group: str


#: The whole vocabulary. Adding a field here is what makes it available; there
#: is no fallback path that resolves an arbitrary attribute, which is the point.
FIELDS: tuple[MergeField, ...] = (
    MergeField("employee.full_name", "Full name", "Priya Sharma", "Employee"),
    MergeField("employee.email", "Work email", "priya@acme.com", "Employee"),
    MergeField("employee.employee_code", "Employee code", "ACM-0142", "Employee"),
    MergeField("employee.designation", "Designation", "Senior Engineer", "Employee"),
    MergeField("employee.department", "Department", "Engineering", "Employee"),
    MergeField("employee.team", "Team", "Platform", "Employee"),
    MergeField("employee.manager", "Reporting manager", "Arjun Mehta", "Employee"),
    MergeField("employee.joined_on", "Date of joining", "3 August 2026", "Employee"),
    MergeField("employee.employment_type", "Employment type", "Full time", "Employee"),
    MergeField("employee.work_location", "Work location", "Bengaluru", "Employee"),
    MergeField("employee.confirmed_on", "Confirmation date", "3 November 2026", "Employee"),
    MergeField("employee.probation_end_on", "Probation ends", "3 November 2026", "Employee"),
    MergeField("employee.address", "Current address", "12 Residency Road", "Employee"),
    MergeField("employee.city", "City", "Bengaluru", "Employee"),
    MergeField("employee.state", "State", "Karnataka", "Employee"),
    MergeField("employee.postal_code", "PIN code", "560025", "Employee"),

    MergeField("org.name", "Company name", "Acme Demo Ltd", "Company"),
    MergeField("org.legal_name", "Legal name", "Acme Demo Private Limited", "Company"),
    MergeField("org.address", "Registered address", "5 MG Road", "Company"),
    MergeField("org.city", "City", "Bengaluru", "Company"),
    MergeField("org.state", "State", "Karnataka", "Company"),
    MergeField("org.gstin", "GSTIN", "29AABCU9603R1ZM", "Company"),

    MergeField("letter.reference", "Reference number", "ACME/HR/2026/0007", "Letter"),
    MergeField("letter.date", "Date of issue", "24 August 2026", "Letter"),
)

FIELDS_BY_TOKEN: dict[str, MergeField] = {f.token: f for f in FIELDS}


def _human_date(value: date | None) -> str:
    """``3 August 2026``. Never ISO.

    A letter is read by a person and often by a bank or a consulate. ``%-d`` is
    not portable to Windows, hence the explicit int.
    """
    if value is None:
        return ""
    return f"{value.day} {value.strftime('%B %Y')}"


def _title(value: str | None) -> str:
    return (value or "").replace("_", " ").strip().capitalize()


def context_for(
    db: Session,
    *,
    org: Organization,
    subject: User,
    profile: EmployeeProfile | None,
    reference: str = "",
    issued_on: date | None = None,
) -> dict[str, str]:
    """Resolve every registered token for one person, once.

    Built eagerly rather than lazily per token: a letter body mentions a handful
    of fields, the queries behind them are four ``db.get`` calls, and a lazy
    resolver would make the number of queries depend on what a customer typed
    into a template.

    Every value is a string, and a missing one is ``""`` rather than ``None`` —
    the renderer substitutes text, and a template that mentions a field the
    person has not filled in should produce a gap, not the word "None" in the
    middle of an offer letter.
    """
    designation = db.get(Designation, subject.designation_id) if subject.designation_id else None
    department = db.get(Department, subject.department_id) if subject.department_id else None
    team = db.get(Team, subject.team_id) if subject.team_id else None
    manager = db.get(User, subject.manager_id) if subject.manager_id else None

    return {
        "employee.full_name": subject.full_name or "",
        "employee.email": subject.email or "",
        "employee.employee_code": subject.employee_code or "",
        "employee.designation": designation.name if designation else "",
        "employee.department": department.name if department else "",
        "employee.team": team.name if team else "",
        "employee.manager": manager.full_name if manager else "",
        "employee.joined_on": _human_date(subject.joined_on),
        "employee.employment_type": _title(profile.employment_type if profile else None),
        "employee.work_location": (profile.work_location if profile else "") or "",
        "employee.confirmed_on": _human_date(profile.confirmed_on if profile else None),
        "employee.probation_end_on": _human_date(profile.probation_end_on if profile else None),
        "employee.address": (profile.current_address if profile else "") or "",
        "employee.city": (profile.current_city if profile else "") or "",
        "employee.state": (profile.current_state if profile else "") or "",
        "employee.postal_code": (profile.current_postal_code if profile else "") or "",

        "org.name": org.name or "",
        "org.legal_name": org.legal_name or org.name or "",
        "org.address": " ".join(
            part for part in (org.address_line1, org.address_line2) if part
        ),
        "org.city": org.city or "",
        "org.state": org.state or "",
        "org.gstin": org.gstin or "",

        "letter.reference": reference,
        "letter.date": _human_date(issued_on or date.today()),
    }


@dataclass(frozen=True)
class Rendered:
    text: str
    #: Tokens the template used that are not in the registry — a typo, or a
    #: field somebody expected to exist. Surfaced so the caller can refuse to
    #: issue rather than sending "Dear ," to a new hire.
    unknown: tuple[str, ...]
    #: Registered tokens that resolved to nothing, because that person's record
    #: is incomplete. A *warning*, not an error: a confirmation letter for
    #: somebody with no middle name is fine, and blocking on it would make the
    #: feature unusable.
    empty: tuple[str, ...]


def render(body: str, context: dict[str, str]) -> Rendered:
    """Substitute every known token; report the rest.

    Substitution is a single pass over the source. That matters: a two-pass or
    recursive render would let a *value* containing ``{{...}}`` be interpreted
    as a token on the second pass, so an employee could put a merge field in
    their own address and have it expand. One pass makes injected text stay
    text.
    """
    unknown: list[str] = []
    empty: list[str] = []

    def substitute(match: re.Match[str]) -> str:
        token = match.group(1)
        if token not in FIELDS_BY_TOKEN:
            unknown.append(token)
            # Left verbatim rather than blanked, so an author previewing the
            # letter sees exactly which token is wrong and where.
            return match.group(0)
        value = context.get(token, "")
        if not value:
            empty.append(token)
        return value

    text = TOKEN.sub(substitute, body)
    # Sorted and de-duplicated: a token used three times is one problem to fix.
    return Rendered(text=text, unknown=tuple(sorted(set(unknown))),
                    empty=tuple(sorted(set(empty))))


def tokens_in(body: str) -> tuple[str, ...]:
    """Every token a template mentions, known or not."""
    return tuple(sorted({match.group(1) for match in TOKEN.finditer(body)}))


def unknown_tokens(body: str) -> tuple[str, ...]:
    """Validation for the template editor — catch a typo at save time.

    Checked when the template is written rather than only when a letter is
    issued, because the person who can fix ``{{employee.name}}`` is the one
    editing the template, not the one issuing a letter from it three weeks
    later.
    """
    return tuple(t for t in tokens_in(body) if t not in FIELDS_BY_TOKEN)


def as_dicts() -> list[dict]:
    """The registry, for the template editor's field picker."""
    return [
        {"token": f.token, "label": f.label, "example": f.example, "group": f.group}
        for f in FIELDS
    ]
