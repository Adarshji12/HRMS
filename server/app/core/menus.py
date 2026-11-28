"""The menu catalogue behind per-menu role rights.

Every menu in the console, grouped the way the sidebar groups it, with two
things the roles screen and the API guard both need:

* ``writes`` — the API prefixes the menu's screens change data through. A role's
  Add / Edit / Delete on a menu is enforced against these, centrally, in
  ``api.deps.enforce_menu_rights``. A menu with no ``writes`` has nothing to
  add, edit or delete; its row on the roles screen shows only Access.
* ``rights`` — the older per-role permission flags (``can_approve_leave`` and
  the rest) that belong to the menu. They are shown as the row's "other
  rights" and are still enforced by the handlers that always enforced them.

A menu's key is its console route, so the console needs no second lookup to
hide a menu: ``menu_rights["/crm/leads"]`` is the row for /crm/leads.

Reads are not gated per menu at the API. Lists like ``GET /admin/employees`` fill
dropdowns on a dozen screens, and refusing them to a role without the
Employees menu would break pages it can open. Access hides the menu and blocks
its route in the console; the data scope already limits what any read returns.
"""

from __future__ import annotations

from dataclasses import dataclass, field

ACTIONS: tuple[str, ...] = ("add", "edit", "delete")


@dataclass(frozen=True)
class Menu:
    key: str
    label: str
    group: str
    writes: tuple[str, ...] = ()
    rights: tuple[str, ...] = ()
    #: Other console routes that open the same screen.
    aliases: tuple[str, ...] = ()
    #: Shown indented under this menu key on the roles screen.
    parent: str | None = None
    note: str | None = None
    #: The lowest level that can use this menu (see LEVELS); None means everybody.
    level: str | None = None
    #: Tabs inside the screen that a role can be limited to: (key, label). Each is saved on
    #: the menu's row as ``tab_<key>``. Empty for a menu with no tabs.
    tabs: tuple[tuple[str, str], ...] = ()

    @property
    def actions(self) -> tuple[str, ...]:
        return ACTIONS if self.writes else ()


@dataclass(frozen=True)
class Group:
    key: str
    label: str
    description: str
    menus: tuple[Menu, ...] = field(default_factory=tuple)


#: The lowest level that can use a menu: "team" needs a role that sees other people (Manager, Administrator, or a
#: Team or Company data scope), "admin" needs Administrator, "owner" the account holder. Ticking Access on a menu above a
#: role's level changes nothing for the people in it -- the page is hidden, and the server refuses its data -- so the
#: Roles screen locks those rows. Mirrors teamOnly / adminOnly / ownerOnly in the console's nav.tsx (a test keeps them
#: in step).
LEVELS: dict[str, str] = {
    **{k: "team" for k in ("/employees", "/workforce", "/attendance/team", "/leave/team", "/helpdesk/queue", "/tracking",
                           "/hrms/leave", "/hrms/working-hours", "/departments", "/designations", "/branches",
                           "/locations", "/holidays")},
    **{k: "admin" for k in (
        "/roles", "/payroll/overview", "/payroll/runs", "/payroll/slips", "/payroll", "/payroll/setup",
        "/payroll/targets", "/payroll/forms", "/payroll/design", "/payroll/letters", "/payroll/letter-templates",
        "/payroll/year-end", "/settings/approvals", "/settings/tracking", "/assets/dashboard", "/assets",
        "/assets/renewals", "/assets/report", "/crm/settings", "/billing",
        "/settings/expenses", "/erp/settings", "/masters", "/hrms/settings")},
    "/settings/email": "owner",
}
_LEVEL_RANK = {"": 0, "team": 1, "admin": 2, "owner": 3}


def level_allowed(level: str | None, base_role: str, data_scope: str) -> bool:
    """Whether a role built on ``base_role`` with ``data_scope`` can use a menu that needs ``level``."""
    if not level:
        return True
    can_team = base_role in ("manager", "admin") or data_scope != "self"
    ceiling = "admin" if base_role == "admin" else ("team" if can_team else "")
    return _LEVEL_RANK[level] <= _LEVEL_RANK[ceiling]


def _g(key: str, label: str, description: str, *menus: Menu) -> Group:
    return Group(key, label, description, menus)


def _m(key: str, label: str, group: str, writes: tuple[str, ...] = (), rights: tuple[str, ...] = (), **kw) -> Menu:
    level = kw.pop("level", None) or LEVELS.get(key) or ("admin" if key.startswith(("/masters/", "/sales-master/")) else None)
    return Menu(key=key, label=label, group=group, writes=writes, rights=rights, level=level, **kw)


#: The tabs of the Approvals inbox. A role ticks the ones its people may see; a role that
#: has Approvals but ticks only Costsheet opens the inbox with just that queue.
APPROVAL_TABS: tuple[tuple[str, str], ...] = (
    ("regularization", "Attendance"), ("leave", "Leave"), ("timesheet", "Timesheet"),
    ("expense", "Expense Approvals"), ("conveyance", "Claim Expenses"), ("loan", "Loan"),
    ("performance", "Review"), ("incentive", "Incentive"), ("costsheet", "Costsheet"),
)


GROUPS: tuple[Group, ...] = (
    _g("overview", "Overview", "Where people land, and what they sign off.",
       _m("/", "Dashboard", "overview", note="The company's own numbers"),
       _m("/dashboard", "Overview", "overview", parent="/"),
       _m("/dashboards/hr", "HR", "overview", parent="/"),
       _m("/dashboards/crm", "CRM", "overview", parent="/"),
       _m("/dashboards/erp", "ERP", "overview", parent="/"),
       _m("/dashboards/monitor", "Desk Monitor", "overview", parent="/"),
       _m("/home", "Home", "overview"),
       _m("/approvals", "Approvals", "overview", ("/approvals",), tabs=APPROVAL_TABS)),
    _g("people", "Employees", "The roster, roles and the reporting line.",
       _m("/employees", "Employee", "people", ("/admin/employees", "/people"), ("can_manage_people",)),
       _m("/roles", "Role & Permission", "people", ("/roles",), aliases=("/settings/roles",)),
       _m("/hierarchy", "Hierarchy", "people", ("/org/assign",))),
    _g("masters", "Master", "Reference lists the dropdowns are filled from.",
       _m("/masters", "Master page", "masters", ("/crm/plans",), ("can_manage_erp_masters", "can_verify_vendors"), note="Opens the Master page; each list below can be limited on its own"),
       # Lead Master
       _m("/masters/statuses", "Lead status", "masters", ("/crm/masters/statuses",), parent="/masters"),
       _m("/masters/sources", "Lead source", "masters", ("/crm/masters/sources",), parent="/masters"),
       _m("/masters/industries", "Industry", "masters", ("/crm/masters/industries",), parent="/masters"),
       _m("/masters/requirement-types", "Requirement type", "masters", ("/crm/masters/requirement-types",), parent="/masters"),
       # Geography
       _m("/masters/countries", "Country", "masters", ("/crm/masters/countries",), parent="/masters"),
       _m("/masters/states", "State", "masters", ("/crm/masters/states",), parent="/masters"),
       _m("/masters/districts", "District", "masters", ("/crm/masters/districts",), parent="/masters"),
       _m("/masters/cities", "City", "masters", ("/crm/masters/cities",), parent="/masters"),
       _m("/masters/erp/stations", "Stations", "masters", ("/erp/stations",), parent="/masters"),
       # Inventory
       _m("/masters/erp/items", "Items", "masters", ("/erp/items",), parent="/masters"),
       _m("/masters/erp/companies", "Companies", "masters", ("/crm/masters/item-companies",), parent="/masters"),
       _m("/masters/item-categories", "Item categories", "masters", ("/crm/masters/item-categories",), parent="/masters"),
       _m("/masters/erp/subcategories", "Sub categories", "masters", ("/erp/lookups/subcategory",), parent="/masters"),
       _m("/masters/erp/units", "Units", "masters", ("/erp/lookups/unit",), parent="/masters"),
       _m("/masters/erp/hsn", "HSN / SAC", "masters", ("/erp/lookups/hsn",), parent="/masters"),
       _m("/masters/erp/warehouses", "Stores", "masters", ("/erp/warehouses",), parent="/masters"),
       _m("/masters/erp/racks", "Racks", "masters", ("/erp/lookups/rack",), parent="/masters"),
       # Ledger and the openings
       _m("/masters/erp/ledgers", "Ledger", "masters", ("/erp/ledgers",), parent="/masters"),
       _m("/masters/erp/accounts", "List of accounts", "masters", ("/erp/account-groups",), parent="/masters"),
       _m("/masters/erp/ledger-openings", "Ledger openings", "masters", ("/erp/ledger-openings",), parent="/masters"),
       _m("/masters/erp/stock-openings", "Stock openings", "masters", ("/erp/stock-openings",), parent="/masters"),
       # Sales and Service
       _m("/sales-master/opportunity-stages", "Opportunity stage", "masters", ("/crm/masters/opportunity-stages",), parent="/masters"),
       _m("/sales-master/lost-reasons", "Lost reason", "masters", ("/crm/masters/lost-reasons",), parent="/masters"),
       _m("/sales-master/competitors", "Competitor", "masters", ("/crm/masters/competitors",), parent="/masters"),
       _m("/sales-master/territories", "Territory", "masters", ("/crm/masters/territories",), parent="/masters"),
       _m("/sales-master/contact-designations", "Contact designation", "masters", ("/crm/masters/contact-designations",), parent="/masters"),
       _m("/masters/dispositions", "Call disposition", "masters", ("/crm/masters/dispositions",), parent="/masters"),
       _m("/masters/visit-types", "Visit type", "masters", ("/crm/masters/visit-types",), parent="/masters"),
       # Organisation
       _m("/departments", "Department", "masters", ("/org/departments", "/org/teams", "/org/schedules"), parent="/masters"),
       _m("/designations", "Designation", "masters", ("/org/designations",), parent="/masters"),
       _m("/branches", "Branch", "masters", ("/org/branches",), parent="/masters"),
       _m("/locations", "Location", "masters", ("/attendance/locations",), parent="/masters"),
       _m("/holidays", "Holiday", "masters", ("/leave/holidays",), parent="/masters")),
    _g("hrms", "HRMS", "Attendance, leave, payroll and the day-to-day of HR.",
       _m("/hrms/dashboard", "HR Dashboard", "hrms"),
       _m("/hrms/working-hours", "Working Hours", "hrms"),
       _m("/tracking", "Employee Tracking", "hrms"),
       _m("/hrms/leave", "Leave", "hrms", ("/leave/carry-forward",)),
              _m("/attendance", "Attendance", "hrms", ("/attendance/punch", "/regularization"), ("can_punch_anywhere",)),
       _m("/workforce", "Workforce overview", "hrms", parent="/attendance"),
       _m("/attendance/team", "Team attendance", "hrms",
          ("/attendance/recompute", "/attendance/shift-assignments"), ("can_approve_regularization",), parent="/attendance"),
       _m("/leave", "My leave", "hrms", ("/leave/applications",), parent="/attendance"),
       _m("/leave/team", "Team leave", "hrms", ("/leave/balances",), ("can_approve_leave",), parent="/attendance"),
       _m("/payslips", "Payroll", "hrms", aliases=("/salary",), note="My payslips for an employee; the pay screens below are its tabs"),
       _m("/payroll/overview", "Payroll overview", "hrms", parent="/payslips"),
       _m("/payroll/runs", "Pay runs", "hrms", ("/payruns",), ("can_manage_payroll",), parent="/payslips"),
       _m("/payroll/slips", "Salary slips", "hrms", parent="/payslips"),
       _m("/payroll", "Employee Salaries", "hrms", ("/payroll/structures", "/payroll/preview"), parent="/payslips"),
       _m("/payroll/setup", "Salary setup", "hrms", ("/payroll/components", "/payroll/templates"), parent="/payslips"),
       _m("/payroll/targets", "Sales Targets", "hrms", ("/incentives",), parent="/payslips"),
       _m("/payroll/forms", "Forms & Registers", "hrms", parent="/payslips"),
       _m("/payroll/design", "Payslip & Letterhead designs", "hrms", ("/payslip-design",), parent="/payslips"),
       _m("/payroll/letters", "Letters", "hrms", ("/letters",), ("can_issue_letters",), parent="/payslips"),
       _m("/payroll/letter-templates", "Letter Templates", "hrms", parent="/payslips"),
       _m("/payroll/year-end", "Year end & Form 16", "hrms", ("/form16",), parent="/payslips"),
       _m("/expenses", "Expense", "hrms", ("/expenses",), ("can_approve_expenses", "can_reimburse_expenses")),
       _m("/loans", "Loans & advances", "hrms", ("/loans",), ("can_approve_loans", "can_disburse_loans"), parent="/expenses"),
       _m("/hrms/settings", "HR Settings", "hrms",
          ("/hr/settings", "/attendance/settings", "/attendance/shifts",
           "/leave/settings", "/leave/types", "/statutory", "/notifications",
           "/onboarding", "/offboarding", "/engagement", "/performance/cycles", "/performance/competencies", "/performance/reviews"),
          ("can_manage_performance", "can_manage_engagement", "can_manage_onboarding"),
          note="Also covers the noticeboard and performance reviews, whose pages are no longer in the sidebar"),
       _m("/settings/approvals", "Approval chains", "hrms", ("/workflow",), parent="/hrms/settings")),
    _g("time", "Desk Monitor", "Time tracking, activity and projects.",
       _m("/timesheets", "Timesheets", "time", ("/timesheets",), ("can_approve_timesheets",)),
       _m("/activity", "Time & Activity", "time"),
       _m("/apps", "Apps & Websites", "time", ("/admin/rules", "/admin/reclassify")),
       _m("/screenshots", "Screenshots", "time", rights=("can_view_screenshots",)),
       _m("/projects", "Projects", "time", ("/projects",), ("can_manage_projects",)),
       _m("/reports", "Reports", "time", rights=("can_export_data",)),
       _m("/settings/tracking", "Desk Monitor settings", "time", ("/admin/settings",))),
    _g("assets", "Asset Management", "Company equipment and who holds it.",
       _m("/assets/dashboard", "Asset dashboard", "assets"),
       _m("/assets", "All assets", "assets", ("/assets",), ("can_manage_assets",)),
       _m("/assets/renewals", "Renewals", "assets"),
       _m("/assets/report", "Assignment report", "assets"),
       _m("/my-assets", "My assets", "assets")),
    _g("helpdesk", "Helpdesk", "Incidents and tickets, and the team that answers them.",
       _m("/helpdesk", "Helpdesk", "helpdesk", ("/helpdesk/tickets",)),
       _m("/helpdesk/queue", "Ticket queue", "helpdesk",
          ("/helpdesk/categories", "/helpdesk/staff", "/helpdesk/sla"), ("can_manage_helpdesk",))),
    _g("crm", "CRM", "Leads, follow-ups, visits, customers and quotations.",
       _m("/crm", "Lead Dashboard", "crm"),
       _m("/crm/leads", "My Leads", "crm", ("/crm/leads", "/crm/intake", "/crm/interactions")),
       _m("/crm/follow-ups", "My Follow-ups", "crm", ("/crm/follow-ups", "/crm/reminders")),
       _m("/crm/visits", "My Visit", "crm", ("/crm/visits",)),
       _m("/crm/support", "My Support Desk", "crm"),
       _m("/crm/customers", "My Customers", "crm", ("/crm/customers",)),
       _m("/crm/quotations", "Quotation", "crm", ("/crm/quotations",)),
       _m("/crm/settings", "CRM Setting", "crm", ("/crm/settings",))),
    _g("erp", "ERP", "Buying, stock, selling and billing.",
       _m("/erp", "ERP Dashboard", "erp"),
       _m("/erp/invoices", "Sale", "erp", ("/erp/invoices", "/erp/receipts", "/erp/credit-notes", "/erp/sale-bills"),
          ("can_manage_billing", "can_approve_billing"), aliases=("/erp/billing",)),
       _m("/erp/sales-orders", "Sale Order", "erp", ("/erp/sales-orders", "/erp/dispatches", "/erp/milestones"),
          ("can_manage_sales_orders", "can_approve_sales_orders", "can_delete_sales_orders")),
       _m("/erp/sale-return", "Sale Return", "erp"),
       _m("/erp/stock-issue", "Stock Issue", "erp"),
       _m("/erp/purchase-orders", "Purchase Order", "erp",
          ("/erp/purchase-orders", "/erp/goods-receipts", "/erp/requisitions", "/erp/rfqs"),
          ("can_approve_purchases", "can_manage_procurement")),
       _m("/erp/purchase", "Purchase", "erp"),
       _m("/erp/purchase-returns", "Purchase Return", "erp"),
       _m("/erp/inventory", "Stock Receive", "erp", ("/erp/stock-docs",), ("can_manage_inventory", "can_approve_stock")),
       _m("/erp/settings", "ERP Setting", "erp", ("/erp/settings", "/erp/bill-series"))),
    _g("settings", "Settings", "The workspace itself.",
       _m("/settings/company", "Company profile", "settings", ("/org/company",)),
       _m("/settings/notifications", "Notifications", "settings"),
       _m("/settings/email", "Email setup", "settings", ("/admin/mail",)),
       _m("/billing", "Subscription & Billing", "settings"),
       _m("/settings/expenses", "Expense settings", "settings", ("/expenses/categories",))),
)

MENUS: tuple[Menu, ...] = tuple(m for g in GROUPS for m in g.menus)
BY_KEY: dict[str, Menu] = {m.key: m for m in MENUS}

# Longest prefix first, so /attendance/settings wins over /attendance.
_WRITE_PREFIXES: tuple[tuple[str, Menu], ...] = tuple(
    sorted(((p, m) for m in MENUS for p in m.writes), key=lambda pair: len(pair[0]), reverse=True)
)


def menu_for_write(path: str) -> tuple[Menu, str] | None:
    """The menu an API path writes through, and the path left after its prefix."""
    for prefix, menu in _WRITE_PREFIXES:
        if path == prefix or path.startswith(prefix + "/"):
            return menu, path[len(prefix):]
    return None


def action_for(method: str, remainder: str) -> str | None:
    """Which right a write needs.

    POST to the collection itself creates, so it is Add. POST to anything under
    it — ``/leads/{id}/convert``, ``/runs/{id}/finalise`` — acts on something
    that exists, so it is Edit. PUT and PATCH are Edit, DELETE is Delete.
    """
    method = method.upper()
    if method == "DELETE":
        return "delete"
    if method in ("PUT", "PATCH"):
        return "edit"
    if method == "POST":
        return "add" if remainder.strip("/") == "" else "edit"
    return None


#: Menus that were renamed, merged or moved: a role saved under the old key keeps its rights under the new one.
RENAMED: dict[str, str] = {
    "/salary": "/payslips",
    "/erp/billing": "/erp/invoices",
    "/erp/masters": "/masters",
    "/erp/requisitions": "/erp/purchase-orders",
    "/erp/rfqs": "/erp/purchase-orders",
    "/settings/attendance": "/hrms/settings",
    "/settings/leave": "/hrms/settings",
    "/settings/payroll": "/hrms/settings",
    "/settings/organisation": "/departments",
    "/hrms/joiners-letters": "/payroll/letters",
    "/dashboards/time": "/dashboards/monitor",
    "/dashboards/attendance": "/dashboards/hr",
    "/loans/manage": "/loans",
}


#: Menus split out of an older, broader row: a role that had the broad row is given the same rights on each new one
#: until somebody sets them apart, so splitting a menu never locks a role out of what it could already do.
INHERITS: dict[str, str] = {
    **{m.key: "/masters" for m in MENUS if m.parent == "/masters"},
    **{key: "/departments" for key in ("/branches", "/locations", "/holidays")},
}


def normalise(rights: dict | None) -> dict | None:
    """Saved rights read against today's catalogue: rows for menus that no longer exist are dropped, and a renamed
    menu's row is carried to its new key unless the role already has one there. ``None`` stays None."""
    if rights is None:
        return None
    out = {key: row for key, row in rights.items() if key in BY_KEY}
    for old, new in RENAMED.items():
        if old in rights and new in BY_KEY and new not in out:
            out[new] = rights[old]
    for key, source in INHERITS.items():
        if key not in out and source in out:
            out[key] = out[source]
    return out


#: When True, ``clean_menu_rights`` switches off any menu above the role's level. Off: the Roles screen restricts nothing.
ENFORCE_LEVELS = False


def clean_menu_rights(raw: dict | None, base_role: str | None = None, data_scope: str | None = None) -> dict[str, dict[str, bool]] | None:
    """Keep only known menus and the actions each one has. ``None`` stays None.

    A menu absent from a saved dict is off — the same rule the permission flags
    follow, so a menu added to the product later starts closed for every role
    that was already restricted.
    """
    if raw is None:
        return None
    out: dict[str, dict[str, bool]] = {}
    for key, value in raw.items():
        menu = BY_KEY.get(key)
        if menu is None or not isinstance(value, dict):
            continue
        access = bool(value.get("access"))
        # A menu above the role's level cannot be granted: it would show nothing but a refusal.
        # Nothing is forced off by level: what a role may tick is the administrator's call (see ``level_allowed`` for
        # the level a menu really needs, which the console and the API still apply on their own).
        if ENFORCE_LEVELS and access and base_role is not None and not level_allowed(menu.level, base_role, data_scope or "self"):
            access = False
        row = {"access": access}
        for action in menu.actions:
            row[action] = access and bool(value.get(action))
        for tab, _label in menu.tabs:
            name = f"tab_{tab}"
            if not access:
                row[name] = False
            elif name in value:
                row[name] = bool(value[name])
            elif tab != "costsheet":
                # A role saved before tabs existed keeps every tab it had. The costsheet
                # tab is left unsaid, so it keeps following the older rule (managers).
                row[name] = True
        out[key] = row
    return out


def full_rights() -> dict[str, dict[str, bool]]:
    """Every menu open with every action — what an unrestricted role amounts to."""
    return {m.key: {"access": True, **{a: True for a in m.actions}} for m in MENUS}


def effective_for_console(rights: dict[str, dict[str, bool]] | None) -> dict[str, dict[str, bool]] | None:
    """The rights as the console reads them: each alias carries its menu's row."""
    rights = normalise(rights)
    if rights is None:
        return None
    out = dict(rights)
    for menu in MENUS:
        row = rights.get(menu.key, {"access": False})
        for alias in menu.aliases:
            out[alias] = row
    return out
