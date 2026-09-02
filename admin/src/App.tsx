import { useEffect, useState } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { canAdminister, canApproveSomething, canViewTeam, isOwner, useAuth } from './lib/auth'
import { NAV, firstRouteIn, locate, topLevelItems, visibleModules } from './lib/nav'
import ModulePanel from './components/ModulePanel'
import {
  AttendanceOverview,
  ExpenseOverview,
  LeaveOverview,
  TimeOverview,
} from './pages/hrms/overview/Overviews'
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
import CompanyProfile from './pages/CompanyProfile'
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
import Roles from './pages/hrms/roles/Roles'
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
import PayrollOverview from './pages/hrms/payroll/PayrollOverview'
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
import Chat from './pages/hrms/chat/Chat'
import Meetings from './pages/hrms/meetings/Meetings'
import WorkforceOverview from './pages/hrms/workforce/WorkforceOverview'
import EmployeeHome from './pages/hrms/home/EmployeeHome'
// CRM. Its own module, and the only one whose subject is somebody outside the
// company — see the note on the nav group.
import LeadDashboard from './pages/crm/LeadDashboard'
import MyLeads from './pages/crm/MyLeads'
import MyFollowUps from './pages/crm/MyFollowUps'
import MyVisits from './pages/crm/MyVisits'
import SupportCenter from './pages/crm/SupportCenter'
import MyCustomers from './pages/crm/MyCustomers'
import Quotations from './pages/crm/Quotations'
import QuotationEditor from './pages/crm/QuotationEditor'
import DailyReminders from './pages/crm/DailyReminders'
import CrmSettings from './pages/crm/CrmSettings'
import ApprovalsInbox from './pages/hrms/home/ApprovalsInbox'
import { IconClose, IconPanel, IconSignOut } from './components/Icons'

const COLLAPSE_KEY = 'hrdesktimesol.nav-collapsed'

/* Which module a NavGroup key names. The panels take the group itself rather
   than a key so that ModulePanel never has to know NAV exists. */
const mod = (key: string) => NAV.find((group) => group.key === key)!

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
  /* Where a bare /settings lands. An employee holds none of the admin pages,
     so a fixed target would be a redirect into a permission bounce; the first
     entry they can open is the only answer that works for every role. The
     fallback is unreachable while Notifications stays ungated — it is there so
     that stops being an assumption the router depends on. */
  const settingsHome = firstRouteIn(mod('settings'), access) ?? '/'
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

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
  }, [collapsed])

  /* The entry holding the current page, from `locate` — the same function the
     breadcrumb and the command palette use. Its heading is the module, which is
     what lights the rail row. Nothing is stored: with the rail flat there is no
     open/shut state left to remember, so the per-browser list of opened groups
     went with it. */
  const here = locate(location.pathname, access)

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

        {/* Four destinations, then one row per module.
            The rail used to list every page in the product behind collapsible
            headings — sixteen rows for an administrator with everything shut,
            fifty with everything open, and a scrollbar either way. The second
            level lives in each module's panel now, so this is flat: it never
            scrolls, nothing has to be opened to be seen, and every row is one
            click from where it says it goes. */}
        {/* Dashboard's row sits ABOVE the plain rows rather than with the other
            modules, because it is the landing page and burying it fourth would
            be a demotion. It is a module in every other respect — it opens a
            panel, and `moduleOf` keeps it lit across all five of its tabs. */}
        <div className="nav-section">
          {(() => {
            const dash = visibleModules(access).find((g) => g.key === 'dashboard')
            const to = dash && firstRouteIn(dash, access)
            if (!dash || !to) return null
            const Glyph = dash.icon!
            return (
              <Link
                to={to}
                className="nav-link"
                aria-current={here?.heading === dash.heading ? 'page' : undefined}
                title={collapsed ? dash.heading : undefined}
              >
                <Glyph />
                <span className="nav-label">{dash.heading}</span>
              </Link>
            )
          })()}
          {topLevelItems(access).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className="nav-link"
              // The only label left once the rail collapses to icons.
              title={collapsed ? item.label : undefined}
            >
              <item.icon />
              <span className="nav-label">{item.label}</span>
            </NavLink>
          ))}
        </div>

        <div className="nav-section">
          {visibleModules(access).filter((g) => g.key !== 'dashboard').map((group) => {
            /* Points at the first page this person can open, not a fixed one:
               an employee holds none of Payroll's administration pages, so a
               row hard-wired to /payroll/runs would be a link into a bounce. */
            const to = firstRouteIn(group, access)
            if (!to) return null
            const Glyph = group.icon!
            /* A plain <Link>, deliberately, not a NavLink: NavLink computes
               aria-current from whether the URL equals its own `to`, and
               overwrites anything passed in. This row points at the module's
               FIRST page but has to stay lit on all of them — with a NavLink,
               opening My payslips turned the Payroll row dark. Owning the
               attribute is the only way to say "lit for the whole module". */
            const current = here?.heading === group.heading
            return (
              <Link
                key={group.key}
                to={to}
                className="nav-link"
                aria-current={current ? 'page' : undefined}
                title={collapsed ? group.heading : undefined}
              >
                <Glyph />
                <span className="nav-label">{group.heading}</span>
              </Link>
            )
          })}
        </div>

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
          settingsHome={settingsHome}
          onOpenDrawer={() => setDrawerOpen(true)}
          drawerOpen={drawerOpen}
        />

        <main className="main">
        <Routes>
          {/* Not modules — destinations. Dashboard, Home, Approvals and My
              performance are what people come here to click, and putting a
              category rail in front of a dashboard would be a menu guarding a
              single page. They render bare. */}
          {/* --- Dashboards ------------------------------------------------
              One panel, five tabs, reached from the sidebar's Dashboard row.
              They were each module's first tab until it became clear that is
              the wrong home for them: somebody opening a dashboard is comparing
              across modules, and five clicks into five modules is not
              comparing.

              The three that aggregate other people are team-gated to match
              their nav entries — /admin/dashboard scopes itself server-side, so
              an employee would get a truthful payload under labels written for
              a company ("1 of 9 online"), which is the exact bug Dashboard's
              own comment records having to fix once already. */}
          <Route element={<ModulePanel group={mod('dashboard')} />}>
            {/* An employee's landing page is their day, not the company's.
                Dashboard is a monitoring surface; §9.3's home screen is the
                answer, and a "day one screen" nobody lands on is not one. */}
            <Route
              path="/"
              element={access.canViewTeam ? <Dashboard /> : <EmployeeHome />}
            />
            <Route
              path="/dashboards/time"
              element={access.canViewTeam ? <TimeOverview /> : <Navigate to="/" replace />}
            />
            <Route
              path="/dashboards/attendance"
              element={access.canViewTeam ? <AttendanceOverview /> : <Navigate to="/" replace />}
            />
            <Route path="/dashboards/leave" element={<LeaveOverview />} />
            <Route path="/dashboards/expenses" element={<ExpenseOverview />} />
          </Route>

          <Route path="/home" element={<EmployeeHome />} />

          {/* Teams. Both ungated, exactly as they were when they sat bare in
              the rail — the panel is navigation, not a permission. */}
          <Route element={<ModulePanel group={mod('teams')} />}>
            <Route path="/chat" element={<Chat />} />
            <Route path="/meetings" element={<Meetings />} />
          </Route>
          {/* Not `canViewTeam`: the inbox now holds expense claims and loan
              requests, and somebody in finance who decides those is routinely
              nobody's manager. */}
          <Route
            path="/approvals"
            element={access.canApprove ? <ApprovalsInbox /> : <Navigate to="/home" replace />}
          />
          {/* --- Modules ----------------------------------------------------
              Every route below sits inside a PATHLESS layout route, so each page
              gains its module's category rail while keeping the exact URL it
              always had. That is the whole trick: no address changed, no
              redirect was needed, and a bookmark saved a year ago still lands on
              the same page — it simply arrives with the module's other pages
              listed beside it now.

              Guards are unchanged, and they stay on the individual routes
              rather than moving up to the layout, because a module is not a
              permission: Payroll holds four pages every employee owns and five
              only an administrator does, and gating the panel would take the
              first four away in order to protect the last five. */}

          <Route element={<ModulePanel group={mod('time')} />}>
            <Route path="/timesheets" element={page('timesheets', <Timesheets />)} />
            <Route path="/activity" element={page('activity', <TimeActivity />)} />
            <Route path="/apps" element={page('apps', <AppsWebsites />)} />
            <Route path="/screenshots" element={<Screenshots />} />
            <Route path="/projects" element={page('projects', <Projects />)} />
            <Route path="/projects/:projectId" element={<ProjectDetail />} />
            <Route path="/reports" element={page('reports', <Reports />)} />
          </Route>

          {/* Core HR. `/profile` is your own; `/people/:userId` is somebody
              else's and the server refuses it unless you administer people —
              the refusal belongs there, not in a route guard here, because a
              hidden route would leave the API reachable anyway.

              Letters: `/my-letters` is self-service and open to everyone; the
              other two are administration and the server refuses them without
              can_issue_letters, so the redirect here is tidiness rather than
              the guard. */}
          <Route element={<ModulePanel group={mod('people')} />}>
            <Route path="/profile" element={<MyProfile />} />
            <Route path="/people/:userId" element={<PersonProfile />} />
            <Route path="/my-letters" element={<MyLetters />} />
            <Route path="/directory" element={<Directory />} />
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
            <Route path="/hierarchy" element={page('hierarchy', <Hierarchy />)} />
            <Route
              path="/letters"
              element={isAdmin ? <Letters /> : <Navigate to="/my-letters" replace />}
            />
            <Route
              path="/letters/templates"
              element={isAdmin ? <LetterTemplates /> : <Navigate to="/my-letters" replace />}
            />
          </Route>

          {/* No `page(...)` wrapper from here down: that helper enforces the
              per-employee deny-list, and PAGE_GUARDS in app/api/deps.py has no
              entry for attendance, leave, assets or helpdesk yet. Wrapping them
              anyway would hide the link while leaving the data reachable, which
              nav.tsx's own comment calls out as decoration rather than a guard.
              Add the server guard first, then the wrapper here. */}
          {/* One panel over both halves now — attendance and leave answer the
              two sides of "who is expected in", and the overview reads across
              them. An employee sent to /workforce lands on their own attendance
              rather than a 403: the overview is a page about other people, not
              a locked door. */}
          <Route element={<ModulePanel group={mod('workforce')} />}>
            <Route
              path="/workforce"
              element={
                access.canViewTeam
                  ? page('leave', <WorkforceOverview />)
                  : <Navigate to="/attendance" replace />
              }
            />
            <Route path="/attendance" element={<MyAttendance />} />
            <Route
              path="/attendance/team"
              element={access.canViewTeam ? <TeamAttendance /> : <Navigate to="/attendance" replace />}
            />
            <Route path="/leave" element={<MyLeave />} />
            <Route
              path="/leave/team"
              element={access.canViewTeam ? <TeamLeave /> : <Navigate to="/leave" replace />}
            />
          </Route>

          {/* Expenses: approval needs a role that sees other people; payment is
              administrators only, and the server enforces both — these
              redirects keep a wrong link from landing on a 403 page.

              Loans: administration is administrators only. Sanctioning a loan is
              not a line-management decision, so there is no manager surface here
              at all, unlike expenses. */}
          <Route element={<ModulePanel group={mod('money')} />}>
            <Route path="/expenses" element={<MyExpenses />} />
            <Route
              path="/expenses/review"
              element={access.canViewTeam ? <ExpenseReview /> : <Navigate to="/expenses" replace />}
            />
            <Route
              path="/expenses/payments"
              element={isAdmin ? <ExpensePayments /> : <Navigate to="/expenses" replace />}
            />
            <Route path="/loans" element={<MyLoans />} />
            <Route
              path="/loans/manage"
              element={isAdmin ? <LoanAdmin /> : <Navigate to="/loans" replace />}
            />
            <Route
              path="/loans/deductions"
              element={isAdmin ? <LoanDeductions /> : <Navigate to="/loans" replace />}
            />
          </Route>

          {/* `/salary`, `/payslips`, `/tax` and `/form16` are the employee's own
              and need nothing. The administration half needs `can_manage_payroll`,
              which the server checks and an owner holds implicitly — `isAdmin`
              here is the coarse redirect, not the guard. */}
          <Route element={<ModulePanel group={mod('payroll')} />}>
            <Route path="/salary" element={<MySalary />} />
            <Route path="/payslips" element={<MyPayslips />} />
            <Route path="/tax" element={<TaxDeclarationPage />} />
            <Route path="/form16" element={<MyForm16 />} />
            <Route
              path="/payroll/overview"
              element={isAdmin ? <PayrollOverview /> : <Navigate to="/payslips" replace />}
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
              path="/payroll/tax"
              element={isAdmin ? <TaxVerification /> : <Navigate to="/tax" replace />}
            />
            <Route
              path="/payroll/year-end"
              element={isAdmin ? <YearEnd /> : <Navigate to="/form16" replace />}
            />
          </Route>

          {/* An employee sent to /assets lands on their own kit rather than a
              403 — the admin register is a different page, not a locked door. */}
          <Route element={<ModulePanel group={mod('assets')} />}>
            <Route path="/my-assets" element={<MyAssets />} />
            <Route path="/assets" element={isAdmin ? <Assets /> : <Navigate to="/my-assets" replace />} />
          </Route>

          <Route element={<ModulePanel group={mod('helpdesk')} />}>
            <Route path="/helpdesk" element={<Helpdesk />} />
            <Route
              path="/helpdesk/queue"
              element={access.canViewTeam ? <HelpdeskQueue /> : <Navigate to="/helpdesk" replace />}
            />
          </Route>

          {/* An employee sent to /onboarding lands on their own checklist rather
              than a 403 — same shape as /assets above. Offboarding has no
              employee-facing half, deliberately: an exit record carries why
              somebody was terminated and the last money owed to them. */}
          <Route element={<ModulePanel group={mod('lifecycle')} />}>
            <Route path="/my-onboarding" element={<MyOnboarding />} />
            <Route
              path="/onboarding"
              element={isAdmin ? <Onboarding /> : <Navigate to="/my-onboarding" replace />}
            />
            <Route
              path="/offboarding"
              element={isAdmin ? <Offboarding /> : <Navigate to="/" replace />}
            />
          </Route>

          {/* The noticeboard is everybody's — announcements, the surveys they
              were asked, and the recognition wall. */}
          <Route element={<ModulePanel group={mod('noticeboard')} />}>
            <Route path="/noticeboard" element={<Engagement />} />
            <Route
              path="/communication"
              element={isAdmin ? <EngagementAdmin /> : <Navigate to="/noticeboard" replace />}
            />
          </Route>

          {/* No page guard on /reviews: an employee's own review is theirs, and
              the server scopes it to them. */}
          <Route element={<ModulePanel group={mod('performance')} />}>
            <Route path="/me" element={<MyPerformance />} />
            <Route path="/reviews" element={<MyReview />} />
            <Route
              path="/appraisals"
              element={isAdmin || access.canViewTeam
                ? <Appraisals />
                : <Navigate to="/reviews" replace />}
            />
          </Route>

          {/* CRM. No role gate on the working pages: the server resolves scope
              per person, so an employee opening /crm/leads gets their own
              pipeline rather than a 403 — which is why there is no redirect
              here either. Settings is the exception and matches nav.tsx.

              The quotation builder is a child route rather than a modal: it is
              a document, it is long, and people expect to be able to send
              somebody a link to one. */}
          <Route element={<ModulePanel group={mod('crm')} />}>
            <Route path="/crm" element={<LeadDashboard />} />
            <Route path="/crm/leads" element={<MyLeads />} />
            <Route path="/crm/follow-ups" element={<MyFollowUps />} />
            <Route path="/crm/visits" element={<MyVisits />} />
            <Route path="/crm/support" element={<SupportCenter />} />
            <Route path="/crm/customers" element={<MyCustomers />} />
            <Route path="/crm/quotations" element={<Quotations />} />
            <Route path="/crm/quotations/:quotationId" element={<QuotationEditor />} />
            <Route path="/crm/reminders" element={<DailyReminders />} />
            <Route
              path="/crm/settings"
              element={isAdmin ? <CrmSettings /> : <Navigate to="/crm" replace />}
            />
          </Route>

          {/* Settings. Configuration gathered out of eight other modules — the
              same components, unchanged. The PARENT is deliberately ungated:
              /settings/notifications is every employee's, so gating the door on
              isAdmin would take it away from them. `settingsHome` sends each
              role to the first page they can actually open. */}
          <Route element={<ModulePanel group={mod('settings')} />}>
            <Route path="/settings" element={<Navigate to={settingsHome} replace />} />
            {/* Ungated, like /settings/notifications and for the same reason:
                the page reads to everyone and only offers the form to an
                administrator. The server enforces the write either way. */}
            <Route path="/settings/company" element={<CompanyProfile />} />
            <Route
              path="/settings/roles"
              element={isAdmin ? <Roles /> : <Navigate to={settingsHome} replace />}
            />
            <Route
              path="/settings/organisation"
              element={access.canViewTeam ? <OrgStructure /> : <Navigate to={settingsHome} replace />}
            />
            <Route path="/settings/notifications" element={<NotificationSettings />} />
            <Route
              path="/settings/email"
              element={owner ? <EmailSetup /> : <Navigate to={settingsHome} replace />}
            />
            <Route
              path="/billing"
              element={isAdmin ? <Billing /> : <Navigate to={settingsHome} replace />}
            />
            <Route
              path="/settings/tracking"
              element={isAdmin ? <Settings /> : <Navigate to={settingsHome} replace />}
            />
            <Route
              path="/settings/attendance"
              element={isAdmin ? <AttendanceSettings /> : <Navigate to={settingsHome} replace />}
            />
            <Route
              path="/settings/leave"
              element={isAdmin ? <LeaveSettings /> : <Navigate to={settingsHome} replace />}
            />
            <Route
              path="/settings/expenses"
              element={isAdmin ? <ExpenseSettings /> : <Navigate to={settingsHome} replace />}
            />
            <Route
              path="/settings/payroll"
              element={isAdmin ? <StatutorySettings /> : <Navigate to={settingsHome} replace />}
            />
          </Route>

          {/* Workflow is its own module now. The path keeps its /settings/
              prefix so every bookmark and every link already in the product
              still resolves — the URL is not the thing that moved, the rail
              is. */}
          <Route element={<ModulePanel group={mod('workflow')} />}>
            <Route
              path="/settings/approvals"
              element={isAdmin ? <WorkflowSetup /> : <Navigate to={settingsHome} replace />}
            />
          </Route>

          {/* The addresses the settings pages used to live at. Kept as redirects
              rather than deleted: they are in people's bookmarks, in the
              onboarding emails the product itself sends, and in whatever runbook
              an administrator wrote. A dead link is a support ticket. */}
          <Route path="/organisation" element={<Navigate to="/settings/organisation" replace />} />
          <Route path="/notifications" element={<Navigate to="/settings/notifications" replace />} />
          <Route path="/email" element={<Navigate to="/settings/email" replace />} />
          <Route path="/workflow" element={<Navigate to="/settings/approvals" replace />} />
          <Route path="/attendance/settings" element={<Navigate to="/settings/attendance" replace />} />
          <Route path="/leave/settings" element={<Navigate to="/settings/leave" replace />} />
          <Route path="/expenses/settings" element={<Navigate to="/settings/expenses" replace />} />
          <Route path="/payroll/statutory" element={<Navigate to="/settings/payroll" replace />} />

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
