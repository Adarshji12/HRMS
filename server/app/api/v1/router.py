from fastapi import APIRouter, Depends

from app.api.deps import require_module

from app.api.v1 import (
    admin,
    agent,
    approvals,
    assets,
    attendance,
    chains,
    auth,
    corehr,
    engagement,
    expenses,
    form16,
    helpdesk,
    incometax,
    leave,
    letters,
    loans,
    notifications,
    offboarding,
    onboarding,
    org,
    payroll,
    performance,
    payoutputs,
    payrun,
    projects,
    regularization,
    reports,
    signup,
    statutory,
    superadmin,
    timesheets,
)

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(auth.router)
api_router.include_router(agent.router)
api_router.include_router(admin.router)
api_router.include_router(org.router)
api_router.include_router(projects.router)
api_router.include_router(timesheets.router)
api_router.include_router(notifications.router)
# HRMS modules. Each is self-contained behind its own prefix; ordering among
# them is not load-bearing because no two share a path.
#
# The plan gate is attached HERE rather than inside each module (§9.5): one line
# per module, in the file the lead owns, so no module author can forget it or
# apply it to five of their six routes. An empty `plan.modules` means every
# module, so nothing is gated until an operator deliberately restricts a plan.
api_router.include_router(corehr.router, dependencies=[Depends(require_module("core_hr"))])
api_router.include_router(attendance.router, dependencies=[Depends(require_module("attendance"))])
# Next to attendance deliberately: it is the only other writer of
# attendance_records.
api_router.include_router(
    regularization.router, dependencies=[Depends(require_module("regularization"))]
)
api_router.include_router(leave.router, dependencies=[Depends(require_module("leave"))])
api_router.include_router(letters.router, dependencies=[Depends(require_module("letters"))])
api_router.include_router(expenses.router, dependencies=[Depends(require_module("expenses"))])
api_router.include_router(loans.router, dependencies=[Depends(require_module("loans"))])
api_router.include_router(payroll.router, dependencies=[Depends(require_module("payroll"))])
# Pay runs share the payroll module gate: they are the same capability,
# split across two routers only because one file holding both would be a
# thousand lines.
api_router.include_router(payrun.router, dependencies=[Depends(require_module("payroll"))])
api_router.include_router(statutory.router, dependencies=[Depends(require_module("payroll"))])
api_router.include_router(incometax.router, dependencies=[Depends(require_module("payroll"))])
api_router.include_router(form16.router, dependencies=[Depends(require_module("payroll"))])
api_router.include_router(payoutputs.router, dependencies=[Depends(require_module("payroll"))])
api_router.include_router(assets.router, dependencies=[Depends(require_module("assets"))])
api_router.include_router(helpdesk.router, dependencies=[Depends(require_module("helpdesk"))])
api_router.include_router(onboarding.router, dependencies=[Depends(require_module("onboarding"))])
api_router.include_router(
    offboarding.router, dependencies=[Depends(require_module("offboarding"))]
)
# No module gate. The unified queue is a view over whichever approval flows this
# company actually has: gating it on one module would hide leave requests from a
# company that never bought expenses, and each flow's adapter already applies
# that flow's own permission rule.
api_router.include_router(approvals.router)
# No module gate, like the approvals queue: a chain is configuration for
# whichever flows a company already has, and gating it on one module would
# hide leave routing from a company that never bought expenses.
api_router.include_router(chains.router)
api_router.include_router(
    performance.router, dependencies=[Depends(require_module("performance"))]
)
api_router.include_router(
    engagement.router, dependencies=[Depends(require_module("engagement"))]
)
# Mounted after admin: /admin/reports/summary is a different, older endpoint and
# must keep working for the existing Reports page while this one takes over.
api_router.include_router(reports.router)
# Public, and tenant-less by definition: the tenant does not exist yet.
api_router.include_router(signup.router)
# Platform operators: no tenant, separate token type.
api_router.include_router(superadmin.router)
