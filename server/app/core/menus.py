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

    @property
    def actions(self) -> tuple[str, ...]:
        return ACTIONS if self.writes else ()


@dataclass(frozen=True)
class Group:
    key: str
    label: str
    description: str
    menus: tuple[Menu, ...] = field(default_factory=tuple)


def _g(key: str, label: str, description: str, *menus: Menu) -> Group:
    return Group(key, label, description, menus)


def _m(key: str, label: str, group: str, writes: tuple[str, ...] = (), rights: tuple[str, ...] = (), **kw) -> Menu:
    return Menu(key=key, label=label, group=group, writes=writes, rights=rights, **kw)


GROUPS: tuple[Group, ...] = (
    _g("overview", "Overview", "Where people land, and what they sign off.",
       _m("/", "Dashboard", "overview", note="The company's own numbers"),
       _m("/dashboards/time", "Time & Work", "overview", parent="/"),
       _m("/dashboards/attendance", "Attendance", "overview", parent="/"),
       _m("/dashboards/leave", "Leave", "overview", parent="/"),
       _m("/dashboards/expenses", "Expenses", "overview", parent="/"),
       _m("/home", "Home", "overview"),
       _m("/approvals", "Approvals", "overview", ("/approvals",))),
    _g("people", "Employees", "The roster, roles and the reporting line.",
       _m("/employees", "Employee", "people", ("/admin/employees", "/people"), ("can_manage_people",)),
       _m("/roles", "Role & Permission", "people", ("/roles",), aliases=("/settings/roles",)),
       _m("/hierarchy", "Hierarchy", "people", ("/org/assign",))),
    _g("masters", "Master", "Reference lists the dropdowns are filled from.",
       _m("/masters", "Master lists", "masters", ("/crm/masters", "/crm/plans")),
       _m("/departments", "Department", "masters", ("/org/departments",)),
       _m("/designations", "Designation", "masters", ("/org/designations",))),
    _g("hrms", "HRMS", "Attendance, leave, payroll and the day-to-day of HR.",
       _m("/hrms/dashboard", "HR Dashboard", "hrms"),
       _m("/workforce", "Workforce Management", "hrms"),
       _m("/attendance", "My attendance", "hrms", ("/attendance/punch", "/regularization"), ("can_punch_anywhere",)),
       _m("/attendance/team", "Team attendance", "hrms",
          ("/attendance/recompute", "/attendance/shift-assignments"), ("can_approve_regularization",)),
       _m("/leave", "My leave", "hrms", ("/leave/applications",)),
       _m("/leave/team", "Team leave", "hrms", ("/leave/balances",), ("can_approve_leave",)),
       _m("/salary", "My salary", "hrms"),
       _m("/payslips", "My payslips", "hrms"),
       _m("/tax", "Tax declaration", "hrms", ("/tax",)),
       _m("/form16", "My Form 16", "hrms"),
       _m("/payroll/overview", "Payroll overview", "hrms"),
       _m("/payroll/runs", "Pay runs", "hrms", ("/payruns",), ("can_manage_payroll",)),
       _m("/payroll", "Salary structures", "hrms", ("/payroll/structures", "/payroll/preview")),
       _m("/payroll/components", "Pay components", "hrms", ("/payroll/components",)),
       _m("/payroll/tax", "Tax declarations", "hrms"),
       _m("/payroll/year-end", "Year end & Form 16", "hrms", ("/form16",)),
       _m("/expenses", "My expenses", "hrms", ("/expenses",)),
       _m("/expenses/review", "Expense approvals", "hrms", rights=("can_approve_expenses",)),
       _m("/expenses/payments", "Expense payments", "hrms", rights=("can_reimburse_expenses",)),
       _m("/loans", "My loans", "hrms", ("/loans",)),
       _m("/loans/manage", "Loans & advances", "hrms", rights=("can_approve_loans", "can_disburse_loans")),
       _m("/loans/deductions", "Loan deductions", "hrms", ("/loans/instalments",)),
       _m("/settings/approvals", "Workflow", "hrms", ("/workflow",)),
       _m("/noticeboard", "Noticeboard", "hrms", ("/engagement",), ("can_manage_engagement",)),
       _m("/communication", "Communication", "hrms"),
       _m("/me", "My performance", "hrms"),
       _m("/reviews", "My review", "hrms", ("/performance/reviews",)),
       _m("/appraisals", "Appraisals", "hrms",
          ("/performance/cycles", "/performance/competencies"), ("can_manage_performance",)),
       _m("/hrms/joiners-letters", "Joiners & Letters", "hrms", ("/letters",), ("can_issue_letters",)),
       _m("/my-onboarding", "My onboarding", "hrms"),
       _m("/onboarding", "Onboarding", "hrms", ("/onboarding",), ("can_manage_onboarding",)),
       _m("/offboarding", "Offboarding", "hrms", ("/offboarding",)),
       _m("/hrms/settings", "HR Settings", "hrms", ("/hr/settings",))),
    _g("time", "Desk Monitor", "Time tracking, activity and projects.",
       _m("/timesheets", "Timesheets", "time", ("/timesheets",), ("can_approve_timesheets",)),
       _m("/activity", "Time & Activity", "time"),
       _m("/apps", "Apps & Websites", "time", ("/admin/rules", "/admin/reclassify")),
       _m("/screenshots", "Screenshots", "time", rights=("can_view_screenshots",)),
       _m("/projects", "Projects", "time", ("/projects",), ("can_manage_projects",)),
       _m("/reports", "Reports", "time", rights=("can_export_data",))),
    _g("assets", "Asset Management", "Company equipment and who holds it.",
       _m("/assets/dashboard", "Asset dashboard", "assets"),
       _m("/assets", "All assets", "assets", ("/assets",), ("can_manage_assets",)),
       _m("/assets/renewals", "Renewals", "assets"),
       _m("/assets/report", "Assignment report", "assets"),
       _m("/my-assets", "My assets", "assets")),
    _g("helpdesk", "Helpdesk", "Internal tickets and the team that answers them.",
       _m("/helpdesk", "Helpdesk", "helpdesk", ("/helpdesk/tickets",)),
       _m("/helpdesk/queue", "Ticket queue", "helpdesk",
          ("/helpdesk/categories", "/helpdesk/staff"), ("can_manage_helpdesk",))),
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
       _m("/erp/approvals", "ERP Approvals", "erp"),
       _m("/erp/requisitions", "Requisitions", "erp", ("/erp/requisitions",)),
       _m("/erp/rfqs", "RFQs", "erp", ("/erp/rfqs",), ("can_manage_procurement",)),
       _m("/erp/purchase-orders", "Purchase Orders", "erp",
          ("/erp/purchase-orders", "/erp/goods-receipts"), ("can_approve_purchases",)),
       _m("/erp/inventory", "Inventory", "erp", ("/erp/stock-docs",),
          ("can_manage_inventory", "can_approve_stock")),
       _m("/erp/sales-orders", "Sales Orders", "erp",
          ("/erp/sales-orders", "/erp/dispatches", "/erp/milestones"),
          ("can_manage_sales_orders", "can_approve_sales_orders")),
       _m("/erp/billing", "Billing", "erp", ("/erp/invoices", "/erp/receipts", "/erp/credit-notes"),
          ("can_manage_billing", "can_approve_billing")),
       _m("/erp/masters", "ERP Masters", "erp",
          ("/erp/items", "/erp/warehouses", "/erp/vendors", "/erp/customers"),
          ("can_manage_erp_masters", "can_verify_vendors")),
       _m("/erp/settings", "ERP Setting", "erp", ("/erp/settings",))),
    _g("settings", "Settings", "The workspace itself.",
       _m("/settings/company", "Company profile", "settings", ("/org/company",)),
       _m("/settings/organisation", "Teams & Departments", "settings", ("/org/teams", "/org/schedules")),
       _m("/settings/notifications", "Notifications", "settings"),
       _m("/settings/email", "Email setup", "settings", ("/admin/mail",)),
       _m("/billing", "Subscription & Billing", "settings"),
       _m("/settings/tracking", "Desk Monitor settings", "settings", ("/admin/settings",)),
       _m("/settings/attendance", "Attendance settings", "settings",
          ("/attendance/settings", "/attendance/shifts", "/attendance/locations")),
       _m("/settings/leave", "Leave settings", "settings", ("/leave/settings", "/leave/types", "/leave/holidays")),
       _m("/settings/expenses", "Expense settings", "settings", ("/expenses/categories",)),
       _m("/settings/payroll", "Payroll settings", "settings", ("/statutory",))),
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


def clean_menu_rights(raw: dict | None) -> dict[str, dict[str, bool]] | None:
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
        row = {"access": access}
        for action in menu.actions:
            row[action] = access and bool(value.get(action))
        out[key] = row
    return out


def full_rights() -> dict[str, dict[str, bool]]:
    """Every menu open with every action — what an unrestricted role amounts to."""
    return {m.key: {"access": True, **{a: True for a in m.actions}} for m in MENUS}


def effective_for_console(rights: dict[str, dict[str, bool]] | None) -> dict[str, dict[str, bool]] | None:
    """The rights as the console reads them: each alias carries its menu's row."""
    if rights is None:
        return None
    out = dict(rights)
    for menu in MENUS:
        row = rights.get(menu.key, {"access": False})
        for alias in menu.aliases:
            out[alias] = row
    return out
