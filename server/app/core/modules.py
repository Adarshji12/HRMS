"""The module registry — one list of what this product is made of.

Every gateable capability is declared here once, and everything else reads it:
``core.plans.ALL_MODULES`` (which plans may include), the Super Admin grants
screen (which switches an operator sees), ``deps.require_module`` (what a 402
names), and the tenant console's navigation (which links to render).

Why a registry rather than a bare tuple of strings. Adding a module used to mean
editing ``ALL_MODULES``, then the plan editor's validator, then the platform UI's
hardcoded label map, then the console's nav — four places, and the UI ones fail
silently by rendering a raw slug like ``core_hr``. A module that is one entry
here appears in all four automatically, so the only way to ship a half-registered
module is to not add it at all.

``status`` exists because this file also names modules that are specified but not
yet built. The Super Admin screen shows those greyed with their status, rather
than offering a switch that grants access to routes which do not exist — an
operator toggling a module and seeing nothing happen is a support ticket.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass


class ModuleStatus(str, enum.Enum):
    #: Routes, service and UI all exist. Grantable.
    LIVE = "live"
    #: Specified and scheduled, nothing to grant yet. Shown, not switchable.
    PLANNED = "planned"


@dataclass(frozen=True)
class ModuleDef:
    key: str
    label: str
    #: One line, shown under the switch in the Super Admin grants panel.
    description: str
    #: Groups the switches into sections. Purely presentational.
    group: str
    status: ModuleStatus = ModuleStatus.LIVE

    @property
    def is_grantable(self) -> bool:
        return self.status is ModuleStatus.LIVE


#: Ordered — the Super Admin panel and the plan editor both render in this order,
#: so it is grouped the way an operator thinks about the product rather than
#: alphabetically.
#:
#: The activity/timesheet/billing pipeline is deliberately absent: it predates
#: gating and is what the product *is*. A company with no modules granted still
#: tracks time.
MODULES: tuple[ModuleDef, ...] = (
    ModuleDef(
        "core_hr",
        "Core HR",
        "Employee master records, statutory identity, documents, probation and the directory.",
        "People",
    ),
    ModuleDef(
        "attendance",
        "Attendance",
        "Punch in/out, geofenced office locations, and shift schedules.",
        "Workforce",
    ),
    ModuleDef(
        "regularization",
        "Regularization",
        "Employees ask for a wrong or missing punch to be corrected; managers decide.",
        "Workforce",
    ),
    ModuleDef(
        "leave",
        "Leave",
        "Leave types, balances, holiday calendar and applications.",
        "Workforce",
    ),
    ModuleDef(
        "letters",
        "Letters",
        "Offer, appointment, confirmation, experience and relieving letters from templates.",
        "People",
    ),
    ModuleDef(
        "onboarding",
        "Onboarding",
        "Joining checklists, task templates and document collection.",
        "Lifecycle",
    ),
    ModuleDef(
        "offboarding",
        "Offboarding",
        "Exit workflow, departmental clearance and full-and-final stub.",
        "Lifecycle",
    ),
    ModuleDef(
        "expenses",
        "Expense claims",
        "Employee expense claims with receipts, approval and reimbursement tracking.",
        "Operations",
    ),
    ModuleDef(
        "payroll",
        "Payroll",
        "Salary structures and pay components. Pay runs and statutory filing follow.",
        "Operations",
    ),
    ModuleDef(
        "loans",
        "Loans & advances",
        "Salary advances and loans, with an instalment schedule and outstanding balance.",
        "Operations",
    ),
    ModuleDef(
        "assets",
        "Assets",
        "Company asset register and per-employee custody.",
        "Operations",
    ),
    ModuleDef(
        "performance",
        "Performance",
        "Appraisal cycles, weighted goals, competencies and the review itself.",
        "Operations",
    ),
    ModuleDef(
        "engagement",
        "Engagement",
        "Announcements with read receipts, anonymous pulse surveys and peer recognition.",
        "Operations",
    ),
    ModuleDef(
        "helpdesk",
        "Helpdesk",
        "Employee tickets and HR support queue.",
        "Operations",
    ),
)

MODULES_BY_KEY: dict[str, ModuleDef] = {m.key: m for m in MODULES}

#: Keys a plan or a grant may legally name. Planned modules are excluded on
#: purpose: storing a grant for a module with no routes would read, later, as a
#: customer who has the feature.
GRANTABLE_KEYS: tuple[str, ...] = tuple(m.key for m in MODULES if m.is_grantable)

#: Every declared key including planned ones — for display and validation
#: messages, never for granting.
ALL_KEYS: tuple[str, ...] = tuple(m.key for m in MODULES)


def label_for(key: str) -> str:
    """Human name for a key, falling back to the key itself.

    Falls back rather than raising: this is used in error messages and audit
    detail, and a lookup failure there must not turn a useful 402 into a 500.
    """
    definition = MODULES_BY_KEY.get(key)
    return definition.label if definition else key


def as_dicts() -> list[dict]:
    """The registry as JSON, for the Super Admin grants panel."""
    return [
        {
            "key": m.key,
            "label": m.label,
            "description": m.description,
            "group": m.group,
            "status": m.status.value,
            "grantable": m.is_grantable,
        }
        for m in MODULES
    ]
