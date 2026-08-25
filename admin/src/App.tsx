import { useCallback, useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { canAdminister, canApproveSomething, canViewTeam, isOwner, useAuth } from './lib/auth'
import { NAV, locate } from './lib/nav'
import Brand from './components/Brand'
import Topbar from './components/Topbar'
import { Avatar } from './components/ui'
import Login from './pages/Login'
import Signup from './pages/Signup'
import PlatformApp from './pages/platform/PlatformApp'
import Dashboard from './pages/Dashboard'
import MyPerformance from './pages/MyPerformance'
import NotificationSettings from './pages/NotificationSettings'
import EmailSetup from './pages/EmailSetup'
import Employees from './pages/Employees'
import EmployeeDay from './pages/EmployeeDay'
import OrgStructure from './pages/OrgStructure'
import Hierarchy from './pages/Hierarchy'
import Projects from './pages/Projects'
import ProjectDetail from './pages/ProjectDetail'
import Timesheets from './pages/Timesheets'
import Screenshots from './pages/Screenshots'
import AppsWebsites from './pages/AppsWebsites'
import TimeActivity from './pages/TimeActivity'
import Billing from './pages/Billing'
import Reports from './pages/Reports'
import MyReview from './pages/hrms/performance/MyReview'
import Appraisals from './pages/hrms/performance/Appraisals'
import Engagement from './pages/hrms/engagement/Engagement'
import EngagementAdmin from './pages/hrms/engagement/EngagementAdmin'
import WorkflowSetup from './pages/hrms/workflow/WorkflowSetup'
import Settings from './pages/Settings'
// Core HR. First of the HRMS modules, because everything below hangs off the
// person it describes.
import MyProfile from './pages/hrms/people/MyProfile'
import Directory from './pages/hrms/people/Directory'
import Letters, { MyLetters } from './pages/hrms/letters/Letters'
import LetterTemplates from './pages/hrms/letters/LetterTemplates'
import MyExpenses from './pages/hrms/expenses/MyExpenses'
import { ExpensePayments, ExpenseReview } from './pages/hrms/expenses/ExpenseQueues'
import ExpenseSettings from './pages/hrms/expenses/ExpenseSettings'
import MyLoans, { LoanAdmin, LoanDeductions } from './pages/hrms/loans/Loans'
import MySalary from './pages/hrms/payroll/MySalary'
import SalaryStructures from './pages/hrms/payroll/SalaryStructures'
import PayComponents from './pages/hrms/payroll/PayComponents'
import PayRuns, { MyPayslips } from './pages/hrms/payroll/PayRuns'
import StatutorySettings from './pages/hrms/payroll/StatutorySettings'
import TaxDeclarationPage from './pages/hrms/payroll/TaxDeclaration'
import TaxVerification from './pages/hrms/payroll/TaxVerification'
import YearEnd, { MyForm16 } from './pages/hrms/payroll/YearEnd'
// HRMS. Grouped and kept in module order rather than interleaved above, so the
// nine modules of the product are visible as nine modules in the one file that
// lists every page.
import MyAttendance from './pages/hrms/attendance/MyAttendance'
import TeamAttendance from './pages/hrms/attendance/TeamAttendance'
import AttendanceSettings from './pages/hrms/attendance/AttendanceSettings'
import MyLeave from './pages/hrms/leave/MyLeave'
import TeamLeave from './pages/hrms/leave/TeamLeave'
import LeaveSettings from './pages/hrms/leave/LeaveSettings'
import Assets from './pages/hrms/assets/Assets'
import MyAssets from './pages/hrms/assets/MyAssets'
import Helpdesk from './pages/hrms/helpdesk/Helpdesk'
import HelpdeskQueue from './pages/hrms/helpdesk/HelpdeskQueue'
import Onboarding from './pages/hrms/onboarding/Onboarding'
import MyOnboarding from './pages/hrms/onboarding/MyOnboarding'
import Offboarding from './pages/hrms/offboarding/Offboarding'
import EmployeeHome from './pages/hrms/home/EmployeeHome'
import ApprovalsInbox from './pages/hrms/home/ApprovalsInbox'
import { IconChevronRight, IconClose, IconPanel, IconSignOut } from './components/Icons'

const COLLAPSE_KEY = 'hrdesktimesol.nav-collapsed'
/* Which nav groups the reader has opened. Per-browser and per-person: two
   people sharing a workspace organise their rail differently, and one of them
   opening Payroll is not a statement about the other. */
const OPEN_GROUPS_KEY = 'hrdesktimesol.nav-open-groups'

function storedOpenGroups(): string[] {
  try {
    const raw = localStorage.getItem(OPEN_GROUPS_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    /* A private window, cleared site data, or a browser that throws on access.
       An empty rail is a working rail — every group opens on click. */
    return []
  }
}

function Shell() {
  const { user, organization, logout } = useAuth()
  const location = useLocation()
  const isAdmin = canAdminister(user)
  const owner = isOwner(user)
  const hiddenPages = user?.hidden_pages ?? []
  const access = {
    isAdmin, canViewTeam: canViewTeam(user), isOwner: owner, hiddenPages,
    canApprove: canApproveSomething(user),
  }
  /* The nav hides these and the server refuses them; the route has to agree too,
     or a kept bookmark walks straight past both. */
  const page = (key: string, element: JSX.Element) =>
    hiddenPages.includes(key) ? <Navigate to="/" replace /> : element

  // Two independent states, because they are two different ideas: the desktop
  // rail is a lasting preference, the phone drawer is a momentary one.
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSE_KEY) === '1',
  )
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [openGroups, setOpenGroups] = useState<string[]>(storedOpenGroups)

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
  }, [collapsed])

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify(openGroups))
    } catch {
      /* Nothing to do and nothing to tell anybody: the rail still works, it
         just forgets between visits. */
    }
  }, [openGroups])

  /* The group holding the current page, from `locate` — the same function the
     breadcrumb and the command palette use. Deriving it here rather than
     tracking it in state means a group cannot be shut while the reader is
     standing inside it, which would hide the page they are looking at. */
  const activeHeading = locate(location.pathname, access)?.heading

  const toggleGroup = useCallback((heading: string) => {
    setOpenGroups((open) =>
      open.includes(heading)
        ? open.filter((name) => name !== heading)
        : [...open, heading],
    )
  }, [])

  // A drawer left open over the page you just navigated to is a dead end on a
  // phone: the content is behind a scrim with no obvious way back.
  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false)
    }
    // Locking the body stops the page scrolling underneath the scrim, which
    // otherwise looks like the drawer itself is failing to scroll.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKey)
    }
  }, [drawerOpen])

  const toggleLabel = collapsed ? 'Expand navigation' : 'Collapse navigation'

  return (
    <div
      className={`shell${collapsed ? ' shell-collapsed' : ''}${
        drawerOpen ? ' shell-drawer-open' : ''
      }`}
    >
      {/* Dismiss-on-tap. aria-hidden because the drawer carries a real close
          button; this would only be a second, unlabelled copy of it. */}
      <div className="scrim" onClick={() => setDrawerOpen(false)} aria-hidden="true" />

      <nav className="sidebar" id="primary-nav">
       <div className="sidebar-inner">
        <div className="sidebar-head">
          <Brand />
          <button
            className="icon-btn sidebar-toggle"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={toggleLabel}
            title={toggleLabel}
          >
            <IconPanel />
          </button>
          <button
            className="icon-btn drawer-close"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close navigation"
          >
            <IconClose />
          </button>
        </div>

        {NAV.map((group, index) => {
          const items = group.items.filter(
            (item) =>
              (!item.adminOnly || isAdmin) &&
              (!item.teamOnly || access.canViewTeam) &&
              (!item.approverOnly || access.canApprove) &&
              (!item.ownerOnly || owner) &&
              !(item.page && hiddenPages.includes(item.page)),
          )
          if (items.length === 0) return null

          /* Three ways a group is open, and the order matters:

             1. It has no heading — the Dashboard/Home/Approvals rows, which are
                what people come here to click and must never need a click to
                reveal.
             2. The rail is collapsed to icons. Headings are not rendered at all
                in that mode, so a shut group would be items nobody can reach
                and no control to reach them with.
             3. It holds the current page, or the reader opened it. */
          const isOpen =
            !group.heading ||
            collapsed ||
            group.heading === activeHeading ||
            openGroups.includes(group.heading)

          return (
            <div className="nav-section" key={group.heading ?? index}>
              {group.heading && (
                <button
                  type="button"
                  className={`nav-group nav-group-toggle${isOpen ? ' is-open' : ''}`}
                  aria-expanded={isOpen}
                  onClick={() => toggleGroup(group.heading!)}
                >
                  <span>{group.heading}</span>
                  {/* Count only while shut. Open, the rows say it themselves,
                      and a number beside them is furniture. */}
                  {!isOpen && <span className="nav-group-count">{items.length}</span>}
                  <IconChevronRight size={14} className="nav-chevron" />
                </button>
              )}
              {isOpen && items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={`nav-link${item.sub ? ' nav-sub' : ''}`}
                  // The only label left once the rail collapses to icons.
                  title={collapsed ? item.label : undefined}
                >
                  <item.icon />
                  <span className="nav-label">{item.label}</span>
                </NavLink>
              ))}
            </div>
          )
        })}

        <div className="sidebar-foot">
          {/* Which tenant this is. Obvious from the address in production, but
              anyone with access to two workspaces needs it stated somewhere. */}
          {organization && <div className="foot-org">{organization.name}</div>}
          <div className="foot-user">
            <Avatar name={user?.full_name ?? '?'} small />
            <div className="foot-id">
              <div className="foot-name">{user?.full_name}</div>
              <div className="foot-role">{user?.role}</div>
            </div>
          </div>
          <button
            className="btn btn-sm foot-signout"
            onClick={logout}
            title={collapsed ? 'Sign out' : undefined}
            aria-label="Sign out"
          >
            <IconSignOut size={15} />
            <span className="nav-label">Sign out</span>
          </button>
        </div>
       </div>
      </nav>

      {/* The rail is one column; the bar and the page share the other. They are
          wrapped rather than laid out as shell children so the bar can be
          sticky over the page without also sticking over the rail. */}
      <div className="shell-body">
        <Topbar
          access={access}
          isAdmin={isAdmin}
          onOpenDrawer={() => setDrawerOpen(true)}
          drawerOpen={drawerOpen}
        />

        <main className="main">
        <Routes>
          {/* An employee's landing page is their day, not the company's.
              Dashboard is a monitoring surface — its own comment notes it had to
              stop telling an employee "Whole company" when the scope was
              actually just themselves. §9.3's home screen is the answer, and a
              "day one screen" nobody lands on is not a day one screen.
              /home stays reachable so a manager can open it deliberately. */}
          <Route
            path="/"
            element={access.canViewTeam ? <Dashboard /> : <EmployeeHome />}
          />
          <Route path="/home" element={<EmployeeHome />} />
          {/* Not `canViewTeam`: the inbox now holds expense claims and loan
              requests, and somebody in finance who decides those is routinely
              nobody's manager. */}
          <Route
            path="/approvals"
            element={access.canApprove ? <ApprovalsInbox /> : <Navigate to="/home" replace />}
          />
          <Route path="/me" element={<MyPerformance />} />
          {/* No page guard: an employee's own review is theirs, and the
              server scopes it to them. */}
          <Route path="/reviews" element={<MyReview />} />
          <Route
            path="/workflow"
            element={isAdmin ? <WorkflowSetup /> : <Navigate to="/approvals" replace />}
          />
          {/* The noticeboard is everybody's — announcements, the
              surveys they were asked, and the recognition wall. */}
          <Route path="/noticeboard" element={<Engagement />} />
          <Route
            path="/communication"
            element={isAdmin ? <EngagementAdmin /> : <Navigate to="/noticeboard" replace />}
          />
          <Route
            path="/appraisals"
            element={isAdmin || access.canViewTeam
              ? <Appraisals />
              : <Navigate to="/reviews" replace />}
          />
          <Route path="/notifications" element={<NotificationSettings />} />
          <Route
            path="/email"
            element={owner ? <EmailSetup /> : <Navigate to="/notifications" replace />}
          />
          {/* Hidden from the rail for employees; the routes have to agree, or
              the links are merely invisible rather than actually closed. The
              redirect goes to /me, which is the page that answers what they
              were probably looking for. */}
          <Route
            path="/employees"
            element={access.canViewTeam ? <Employees /> : <Navigate to="/me" replace />}
          />
          {/* Not gated: an employee may open their own day, and the endpoint
              behind it already rejects anyone else's. */}
          <Route path="/employees/:userId" element={<EmployeeDay />} />
          <Route
            path="/organisation"
            element={access.canViewTeam ? <OrgStructure /> : <Navigate to="/me" replace />}
          />
          <Route path="/hierarchy" element={page('hierarchy', <Hierarchy />)} />
          <Route path="/projects" element={page('projects', <Projects />)} />
          <Route path="/projects/:projectId" element={<ProjectDetail />} />
          <Route path="/timesheets" element={page('timesheets', <Timesheets />)} />
          <Route path="/activity" element={page('activity', <TimeActivity />)} />
          <Route path="/apps" element={page('apps', <AppsWebsites />)} />
          <Route path="/screenshots" element={<Screenshots />} />
          <Route path="/reports" element={page('reports', <Reports />)} />
          <Route
            path="/settings"
            element={isAdmin ? <Settings /> : <Navigate to="/" replace />}
          />
          <Route
            path="/billing"
            element={isAdmin ? <Billing /> : <Navigate to="/me" replace />}
          />

          {/* --- HRMS -------------------------------------------------------
              No `page(...)` wrapper on these: that helper enforces the
              per-employee deny-list, and PAGE_GUARDS in app/api/deps.py has no
              entry for attendance, leave, assets or helpdesk yet. Wrapping them
              anyway would hide the link while leaving the data reachable, which
              nav.tsx's own comment calls out as decoration rather than a guard.
              Add the server guard first, then the wrapper here. */}
          {/* Core HR. `/profile` is your own; `/people/:userId` is somebody
              else's and the server refuses it unless you administer people —
              the refusal belongs there, not in a route guard here, because a
              hidden route would leave the API reachable anyway. */}
          <Route path="/profile" element={<MyProfile />} />
          <Route path="/people/:userId" element={<PersonProfile />} />
          <Route path="/directory" element={<Directory />} />

          {/* Letters. `/my-letters` is self-service and open to everyone; the
              other two are administration and the server refuses them without
              can_issue_letters, so the redirect here is tidiness rather than
              the guard. */}
          <Route path="/my-letters" element={<MyLetters />} />
          <Route
            path="/letters"
            element={isAdmin ? <Letters /> : <Navigate to="/my-letters" replace />}
          />
          <Route
            path="/letters/templates"
            element={isAdmin ? <LetterTemplates /> : <Navigate to="/my-letters" replace />}
          />

          {/* Expenses. Approval needs a role that sees other people; payment
              is administrators only, and the server enforces both — these
              redirects keep a wrong link from landing on a 403 page. */}
          <Route path="/expenses" element={<MyExpenses />} />
          <Route
            path="/expenses/review"
            element={access.canViewTeam ? <ExpenseReview /> : <Navigate to="/expenses" replace />}
          />
          <Route
            path="/expenses/payments"
            element={isAdmin ? <ExpensePayments /> : <Navigate to="/expenses" replace />}
          />
          <Route
            path="/expenses/settings"
            element={isAdmin ? <ExpenseSettings /> : <Navigate to="/expenses" replace />}
          />

          {/* Loans. Administration is administrators only — sanctioning a
              loan is not a line-management decision, so there is no manager
              surface here at all, unlike expenses. */}
          <Route path="/loans" element={<MyLoans />} />
          <Route
            path="/loans/manage"
            element={isAdmin ? <LoanAdmin /> : <Navigate to="/loans" replace />}
          />
          <Route
            path="/loans/deductions"
            element={isAdmin ? <LoanDeductions /> : <Navigate to="/loans" replace />}
          />

          {/* Payroll. `/salary` is your own and needs nothing; the other two
              need `can_manage_payroll`, which the server checks — an owner holds
              it implicitly. `isAdmin` here is the coarse redirect, not the
              guard. */}
          <Route path="/salary" element={<MySalary />} />
          <Route path="/payslips" element={<MyPayslips />} />
          {/* The declaration is the employee's own and needs no permission. The
              verification queue needs the payroll capability, which the server
              checks — `isAdmin` here is the coarse redirect. */}
          <Route path="/tax" element={<TaxDeclarationPage />} />
          <Route path="/form16" element={<MyForm16 />} />
          <Route
            path="/payroll/year-end"
            element={isAdmin ? <YearEnd /> : <Navigate to="/form16" replace />}
          />
          <Route
            path="/payroll/tax"
            element={isAdmin ? <TaxVerification /> : <Navigate to="/tax" replace />}
          />
          <Route
            path="/payroll/runs"
            element={isAdmin ? <PayRuns /> : <Navigate to="/payslips" replace />}
          />
          <Route
            path="/payroll"
            element={isAdmin ? <SalaryStructures /> : <Navigate to="/salary" replace />}
          />
          <Route
            path="/payroll/components"
            element={isAdmin ? <PayComponents /> : <Navigate to="/salary" replace />}
          />
          <Route
            path="/payroll/statutory"
            element={isAdmin ? <StatutorySettings /> : <Navigate to="/salary" replace />}
          />

          <Route path="/attendance" element={<MyAttendance />} />
          <Route
            path="/attendance/team"
            element={access.canViewTeam ? <TeamAttendance /> : <Navigate to="/attendance" replace />}
          />
          <Route
            path="/attendance/settings"
            element={isAdmin ? <AttendanceSettings /> : <Navigate to="/attendance" replace />}
          />

          <Route path="/leave" element={<MyLeave />} />
          <Route
            path="/leave/team"
            element={access.canViewTeam ? <TeamLeave /> : <Navigate to="/leave" replace />}
          />
          <Route
            path="/leave/settings"
            element={isAdmin ? <LeaveSettings /> : <Navigate to="/leave" replace />}
          />

          {/* An employee sent to /assets lands on their own kit rather than a
              403 — the admin register is a different page, not a locked door. */}
          <Route path="/assets" element={isAdmin ? <Assets /> : <Navigate to="/my-assets" replace />} />
          <Route path="/my-assets" element={<MyAssets />} />

          <Route path="/helpdesk" element={<Helpdesk />} />
          <Route
            path="/helpdesk/queue"
            element={access.canViewTeam ? <HelpdeskQueue /> : <Navigate to="/helpdesk" replace />}
          />

          {/* An employee sent to /onboarding lands on their own checklist rather
              than a 403 — the HR pipeline is a different page, not a locked
              door. Same shape as /assets above. */}
          <Route
            path="/onboarding"
            element={isAdmin ? <Onboarding /> : <Navigate to="/my-onboarding" replace />}
          />
          <Route path="/my-onboarding" element={<MyOnboarding />} />
          {/* No employee-facing half, deliberately: an exit record carries why
              somebody was terminated and the last money owed to them. */}
          <Route
            path="/offboarding"
            element={isAdmin ? <Offboarding /> : <Navigate to="/" replace />}
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </main>
      </div>
    </div>
  )
}

export default function App() {
  const { user, ready } = useAuth()
  const location = useLocation()

  // The platform console has its own credentials and its own gate. Checked
  // before the company auth state so an operator is never bounced to a tenant
  // login, and a company session never leaks into the platform routes.
  if (location.pathname.startsWith('/platform')) return <PlatformApp />

  if (!ready) return null

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        {/* Public: signup runs on the marketing host, before any tenant exists. */}
        <Route path="/signup" element={<Signup />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: location }} />} />
      </Routes>
    )
  }

  if (location.pathname === '/login' || location.pathname === '/signup') {
    return <Navigate to="/" replace />
  }
  return <Shell />
}

/* `MyProfile` takes the subject as a prop rather than reading the route itself,
   so the same component serves /profile and /people/:userId. This adapter is
   the one line that differs — a second copy of the page would be a second place
   to forget a field. */
function PersonProfile() {
  const { userId } = useParams()
  return <MyProfile userId={userId} />
}
