import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { canAdminister, canApproveSomething, canViewTeam, isOwner, useAuth } from './lib/auth'
import {
  NAV,
  HRMS_NAV_ITEMS,
  ERP_NAV_ITEMS,
  canSee,
  firstRouteIn,
  itemsIn,
  locate,
  menuOpen,
  routeOpen,
  topLevelItems,
  visibleModules,
} from './lib/nav'
import ModulePanel from './components/ModulePanel'
import { TimeOverview } from './pages/hrms/overview/Overviews'
import Brand from './components/Brand'
import Topbar from './components/Topbar'
import { Avatar } from './components/ui'
import Login from './pages/Login'
import { ForgotPassword, ResetPassword } from './pages/PasswordReset'
import Signup from './pages/Signup'
import PlatformApp from './pages/platform/PlatformApp'
import MyPerformance from './pages/MyPerformance'
import JoinersLettersHub from './pages/hrms/JoinersLettersHub'
import HrDashboard from './pages/hrms/home/HrDashboard'
import Dashboard from './pages/Dashboard'
import CompanyOverview from './pages/CompanyOverview'
import HRMSSettings from './pages/hrms/HRMSSettings'
import ErpDashboard from './pages/erp/ErpDashboard'
import ErpApprovals from './pages/erp/ErpApprovals'
import ErpRequisitions from './pages/erp/ErpRequisitions'
import ErpRfqs from './pages/erp/ErpRfqs'
import ErpPurchaseOrders from './pages/erp/ErpPurchaseOrders'
import ErpInventory from './pages/erp/ErpInventory'
import ErpSalesOrders from './pages/erp/ErpSalesOrders'
import ErpBilling from './pages/erp/ErpBilling'
import ErpMasters from './pages/erp/ErpMasters'
import ErpSettingsPage from './pages/erp/ErpSettingsPage'
import NotificationSettings from './pages/NotificationSettings'
import EmailSetup from './pages/EmailSetup'
import CompanyProfile from './pages/CompanyProfile'
import Employees from './pages/Employees'
import EmployeeDay from './pages/EmployeeDay'
import OrgStructure from './pages/OrgStructure'
import ModuleHub from './components/ModuleHub'
import DepartmentMaster from './pages/masters/DepartmentMaster'
import DesignationMaster from './pages/masters/DesignationMaster'
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
import AddEmployee, { EditEmployee } from './pages/hrms/people/hire/AddEmployee'
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
import AssetDashboard from './pages/hrms/assets/AssetDashboard'
import AssetRenewals from './pages/hrms/assets/AssetRenewals'
import AssetReport from './pages/hrms/assets/AssetReport'
import MyAssets from './pages/hrms/assets/MyAssets'
import Helpdesk from './pages/hrms/helpdesk/Helpdesk'
import HelpdeskQueue from './pages/hrms/helpdesk/HelpdeskQueue'
import Onboarding from './pages/hrms/onboarding/Onboarding'
import MyOnboarding from './pages/hrms/onboarding/MyOnboarding'
import Offboarding from './pages/hrms/offboarding/Offboarding'
import WorkforceOverview from './pages/hrms/workforce/WorkforceOverview'
import EmployeeHome from './pages/hrms/home/EmployeeHome'
// CRM. Its own module, and the only one whose subject is somebody outside the
// company — see the note on the nav group.
import LeadDashboard from './pages/crm/LeadDashboard'
import LeadDetail from './pages/crm/LeadDetail'
import MyLeads from './pages/crm/MyLeads'
import MyFollowUps from './pages/crm/MyFollowUps'
import MyVisits from './pages/crm/MyVisits'
import SupportCenter from './pages/crm/SupportCenter'
import MyCustomers from './pages/crm/MyCustomers'
import Quotations from './pages/crm/Quotations'
import QuotationEditor from './pages/crm/QuotationEditor'
import DailyReminders from './pages/crm/DailyReminders'
import CrmSettings from './pages/crm/CrmSettings'
import Masters, { MasterListPage } from './pages/masters/Masters'
import MasterHub from './pages/masters/MasterHub'
import ApprovalsInbox from './pages/hrms/home/ApprovalsInbox'
import {
  IconCard,
  IconChevronDown,
  IconClose,
  IconGrid,
  IconPanel,
  IconSignOut,
  IconUsers,
} from './components/Icons'

const COLLAPSE_KEY = 'hrdesktimesol.nav-collapsed'
const HRMS_HOME_NAV_KEY = 'hrdesktimesol.nav-hrms-home'

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
    menuRights: user?.menu_rights ?? null,
  }
  const hrmsItems = HRMS_NAV_ITEMS.filter((item) => canSee(item, access))
  const hrmsRouteActive = location.pathname !== '/' && hrmsItems.some((item) =>
    location.pathname === item.to || location.pathname.startsWith(`${item.to}/`),
  )
  const hrmsHomeRouteActive = location.pathname === '/' &&
    sessionStorage.getItem(HRMS_HOME_NAV_KEY) === '1'
  const crmModuleGroup = visibleModules(access).find((group) => group.key === 'crm')
  const crmItems = crmModuleGroup ? itemsIn(crmModuleGroup, access) : []
  const crmRouteActive = crmItems.some((item) =>
    location.pathname === item.to || location.pathname.startsWith(`${item.to}/`),
  )
  const erpItems = ERP_NAV_ITEMS.filter((item) => canSee(item, access))
  const erpRouteActive = erpItems.some((item) =>
    location.pathname === item.to || location.pathname.startsWith(`${item.to}/`),
  )
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
    const [hrmsExpanded, setHrmsExpanded] = useState(
      () => hrmsRouteActive || hrmsHomeRouteActive,
    )
    const [erpExpanded, setErpExpanded] = useState(() => erpRouteActive)
    const [crmExpanded, setCrmExpanded] = useState(
      () => crmRouteActive,
    )
    const [selectedModule, setSelectedModule] = useState<'crm' | 'hrms' | 'erp' | null>(null)
  /** A top-level link leaves every module: since a page outside the groups no
   *  longer closes them by itself, these links have to. */
  const closeGroups = () => {
    setCrmExpanded(false)
    setHrmsExpanded(false)
    setErpExpanded(false)
  }

  const selectedModuleItems = selectedModule === 'crm'
    ? crmItems
    : selectedModule === 'hrms'
      ? hrmsItems
      : selectedModule === 'erp'
        ? erpItems
        : []

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
    setSelectedModule(null)
    // Open the group the new page belongs to. A page in no group leaves the
    // groups as they were: module pages link onward to screens that are not
    // on the menu themselves (Payroll to its runs, Workforce to the team's
    // leave, HR Settings to /settings/…), and collapsing the group the person
    // was working in every time they followed one of those read as the menu
    // closing on its own. Top-level links close the groups explicitly.
    const hrmsActive = hrmsRouteActive || hrmsHomeRouteActive
    if (crmRouteActive || erpRouteActive || hrmsActive) {
      setCrmExpanded(crmRouteActive)
      setErpExpanded(erpRouteActive && !crmRouteActive)
      setHrmsExpanded(hrmsActive && !crmRouteActive && !erpRouteActive)
    }
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
  const mainModuleLink = (
    key: string,
    label: string,
    onSelect?: (event: ReactMouseEvent<HTMLAnchorElement>) => void,
  ) => {
    const group = visibleModules(access).find((item) => item.key === key)
    if (!group) return null
    const to = firstRouteIn(group, access)
    if (!to) return null
    const Glyph = group.icon!
    return (
      <Link
        key={key}
        to={to}
        className="nav-link"
        aria-current={here?.heading === group.heading ? 'page' : undefined}
        title={collapsed ? label : undefined}
        onClick={(event) => {
          closeGroups()
          onSelect?.(event)
        }}
      >
        <Glyph />
        <span className="nav-label">{label}</span>
      </Link>
    )
  }

  return (
    <div
          onClick={(event) => {
            if (event.target instanceof Element && event.target.closest('a')) {
              setSelectedModule(null)
              sessionStorage.removeItem(HRMS_HOME_NAV_KEY)
            }
            // The module groups are not closed here. This handler sees every
            // click in the app, so closing them collapsed the CRM menu the
            // moment anyone clicked into a field on a CRM page. Which group is
            // open follows the route (the pathname effect above) and the
            // group toggles themselves.
          }}
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

        <div className="nav-caption">Main menu</div>
        <div className="nav-section">
          {mainModuleLink('dashboard', 'Dashboard')}
          {topLevelItems(access).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className="nav-link"
              // The only label left once the rail collapses to icons.
              title={collapsed ? item.label : undefined}
              onClick={closeGroups}
            >
              <item.icon />
              <span className="nav-label">{item.label}</span>
            </NavLink>
          ))}
          {itemsIn(mod('people'), access).some((item) => item.to === '/employees') &&
            menuOpen('/employees', access.menuRights) && (
            <NavLink
              to="/employees"
              end
              className="nav-link"
              aria-current={location.pathname === '/employees' ? 'page' : undefined}
              title={collapsed ? 'Employees' : undefined}
              onClick={closeGroups}
            >
              <IconUsers />
              <span className="nav-label">Employees</span>
            </NavLink>
          )}
          {/* Every reference list in one place — see pages/masters/Masters.tsx.
              Administrator-only, matching the route and the server's writes. */}
          {isAdmin && menuOpen('/masters', access.menuRights) && (
            <NavLink
              to="/masters"
              className="nav-link"
              title={collapsed ? 'Master' : undefined}
              onClick={closeGroups}
            >
              <IconGrid />
              <span className="nav-label">Master</span>
            </NavLink>
          )}
          {(() => {
            const crmGroup = crmModuleGroup
            if (!crmGroup) return null
            const current = crmExpanded
            const CrmIcon = crmGroup.icon!
            return (
              <div className="nav-module-entry" key="crm">
                <button
                  type="button"
                  className="nav-link hrms-nav-toggle"
                  aria-expanded={crmExpanded}
                  aria-current={here?.heading === crmGroup.heading ? 'page' : undefined}
                  title={collapsed ? 'CRM' : undefined}
                  onClick={(event) => {
                    event.stopPropagation()
                    sessionStorage.removeItem(HRMS_HOME_NAV_KEY)
                    const expanded = !crmExpanded
                    setCrmExpanded(expanded)
                    setSelectedModule(expanded ? 'crm' : null)
                  }}
                >
                  <CrmIcon />
                  <span className="nav-label">CRM</span>
                  <IconChevronDown size={14} className="nav-disclosure-arrow" />
                </button>
                {current && !collapsed && (
                  <div className="crm-nav-submenu">
                    {itemsIn(crmGroup, access).map((item) => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        end={item.end}
                        className="nav-link nav-sub crm-nav-link"
                        onClick={(event) => {
                          event.stopPropagation()
                          setSelectedModule(null)
                          setHrmsExpanded(false)
                          setErpExpanded(false)
                          sessionStorage.removeItem(HRMS_HOME_NAV_KEY)
                        }}
                      >
                        <item.icon />
                        <span className="nav-label">{item.label}</span>
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            )
          })()}
          <button
            type="button"
            className="nav-link hrms-nav-toggle"
            aria-expanded={hrmsExpanded}
            aria-current={hrmsRouteActive ? 'page' : undefined}
            title={collapsed ? 'HRMS' : undefined}
            onClick={(event) => {
              event.stopPropagation()
              sessionStorage.removeItem(HRMS_HOME_NAV_KEY)
              setSelectedModule('hrms')
              setCrmExpanded(false)
              if (collapsed) setCollapsed(false)
              setErpExpanded(false)
              setHrmsExpanded((expanded) => !expanded)
            }}
          >
            <IconUsers />
            <span className="nav-label">HRMS</span>
            <IconChevronDown size={14} className="nav-disclosure-arrow" />
          </button>
          {hrmsExpanded && !collapsed && (
            <div className="hrms-nav-submenu">
              {hrmsItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className="nav-link nav-sub hrms-nav-link"
                  onClick={(event) => {
                    event.stopPropagation()
                    setSelectedModule(null)
                    if (item.to === '/') {
                      sessionStorage.setItem(HRMS_HOME_NAV_KEY, '1')
                    } else {
                      sessionStorage.removeItem(HRMS_HOME_NAV_KEY)
                    }
                  }}
                >
                  <item.icon />
                  <span className="nav-label">{item.label}</span>
                </NavLink>
              ))}
            </div>
          )}
          <button
            type="button"
            className="nav-link erp-nav-toggle"
            aria-expanded={erpExpanded}
            aria-current={erpRouteActive ? 'page' : undefined}
            title={collapsed ? 'ERP' : undefined}
            onClick={(event) => {
              event.stopPropagation()
              sessionStorage.removeItem(HRMS_HOME_NAV_KEY)
              setSelectedModule('erp')
              setCrmExpanded(false)
              if (collapsed) setCollapsed(false)
              setHrmsExpanded(false)
              setErpExpanded((expanded) => !expanded)
            }}
          >
            <IconCard />
            <span className="nav-label">ERP</span>
            <IconChevronDown size={14} className="nav-disclosure-arrow" />
          </button>
          {erpExpanded && !collapsed && (
            <div className="erp-nav-submenu">
              {erpItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className="nav-link nav-sub erp-nav-link"
                  onClick={(event) => {
                    event.stopPropagation()
                    setSelectedModule(null)
                    sessionStorage.removeItem(HRMS_HOME_NAV_KEY)
                  }}
                >
                  <item.icon />
                  <span className="nav-label">{item.label}</span>
                </NavLink>
              ))}
            </div>
          )}
          {mainModuleLink('assets', 'Asset Management')}
          {mainModuleLink('time', 'Desk Monitors')}
          {mainModuleLink('helpdesk', 'HelpDesk')}
          {mainModuleLink('settings', 'Setting')}
        </div>

        <div className="sidebar-foot">
          {/* Which tenant this is. Obvious from the address in production, but
              anyone with access to two workspaces needs it stated somewhere. */}
          {organization && <div className="foot-org">{organization.name}</div>}
          <div className="foot-user">
            <Avatar name={user?.full_name ?? '?'} small />
            <div className="foot-id">
              <div className="foot-name">{user?.full_name}</div>
              <div className="foot-role">{user?.role_name ?? user?.role}</div>
            </div>
            <button
              className="icon-btn foot-signout"
              onClick={logout}
              title="Sign out"
              aria-label="Sign out"
            >
              <IconSignOut size={16} />
            </button>
          </div>
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
          onToggleRail={() => setCollapsed((v) => !v)}
          railCollapsed={collapsed}
        />

        <main className="main">
        {selectedModule ? (
          <ModuleHub
            module={selectedModule}
            items={selectedModuleItems}
            pathname={location.pathname}
            onPick={() => setSelectedModule(null)}
          />
        ) : !routeOpen(location.pathname, access.menuRights) ? (
          // The role's menu rights close this page. The menu is already hidden;
          // this is for a bookmark or a typed address.
          <NoMenuAccess />
        ) : (
        <Routes>
          {/* The root: anybody who sees beyond themselves lands on the company
              dashboard; an employee lands on Home, their own day. */}
          <Route
            path="/"
            element={<Navigate to={access.canViewTeam ? '/dashboard' : '/home'} replace />}
          />

          {/* --- Dashboard ------------------------------------------------
              Overview first, then one tab per module dashboard. */}
          <Route element={<ModulePanel group={mod('dashboard')} />}>
            <Route
              path="/dashboard"
              element={access.canViewTeam ? <CompanyOverview /> : <Navigate to="/home" replace />}
            />
            <Route
              path="/dashboards/hr"
              element={access.canViewTeam ? <HrDashboard /> : <Navigate to="/home" replace />}
            />
            <Route
              path="/dashboards/crm"
              element={access.canViewTeam ? <LeadDashboard /> : <Navigate to="/home" replace />}
            />
            <Route
              path="/dashboards/erp"
              element={access.canViewTeam ? <ErpDashboard /> : <Navigate to="/home" replace />}
            />
            <Route
              path="/dashboards/monitor"
              element={access.canViewTeam ? <Dashboard /> : <Navigate to="/home" replace />}
            />
          </Route>

          {/* Not modules — destinations. Home and Approvals are what people
              come here to click, so they render bare. */}

          <Route path="/home" element={<EmployeeHome />} />
          <Route path="/hrms/dashboard" element={<HrDashboard />} />
          <Route
            path="/hrms/working-hours"
            element={access.canViewTeam ? <TimeOverview /> : <Navigate to="/home" replace />}
          />
          <Route path="/hrms/joiners-letters" element={<JoinersLettersHub />} />
          <Route path="/hrms/settings" element={<HRMSSettings />} />
          {/* ERP phase one. Ungated at the route: every page reads /erp/access
              and the server refuses per capability, so an employee can still
              reach Requisitions to ask for something. Settings is the one
              administrator page, and its form says so rather than vanishing. */}
          <Route path="/erp" element={<ErpDashboard />} />
          <Route path="/erp/approvals" element={<ErpApprovals />} />
          <Route path="/erp/requisitions" element={<ErpRequisitions />} />
          <Route path="/erp/rfqs" element={<ErpRfqs />} />
          <Route path="/erp/purchase-orders" element={<ErpPurchaseOrders />} />
          <Route path="/erp/inventory" element={<ErpInventory />} />
          <Route path="/erp/sales-orders" element={<ErpSalesOrders />} />
          <Route path="/erp/billing" element={<ErpBilling />} />
          <Route path="/erp/masters" element={<ErpMasters />} />
          <Route path="/erp/settings" element={<ErpSettingsPage />} />
          {/* The old placeholder. The general ledger is a later phase; billing
              is where the ERP's money lives today. */}
          <Route path="/erp/ledgers" element={<Navigate to="/erp/billing" replace />} />

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
              hidden route would leave the API reachable anyway. */}
          <Route element={<ModulePanel group={mod('people')} />}>
            <Route path="/profile" element={<MyProfile />} />
            <Route path="/people/:userId" element={<PersonProfile />} />
            {/* Hidden from the rail for employees; the routes have to agree, or
                the links are merely invisible rather than actually closed. The
                redirect goes to /me, which is the page that answers what they
                were probably looking for. */}
            <Route
              path="/employees"
              element={access.canViewTeam ? <Employees /> : <Navigate to="/me" replace />}
            />
            {/* Declared before /employees/:userId only for the reader — the
                router ranks a static segment above a parameter anyway. */}
            <Route
              path="/employees/new"
              element={isAdmin ? <AddEmployee /> : <Navigate to="/employees" replace />}
            />
            {/* Edit is the same ten-step form as Add, on its own page, filled
                with what is on file. */}
            <Route
              path="/employees/:userId/edit"
              element={isAdmin ? <EditEmployee /> : <Navigate to="/employees" replace />}
            />
            {/* Not gated: an employee may open their own day, and the endpoint
                behind it already rejects anyone else's. */}
            <Route path="/employees/:userId" element={<EmployeeDay />} />
            {/* The same Roles page Settings shows, opened inside this panel so
                the Employee tabs stay put. */}
            <Route
              path="/roles"
              element={isAdmin ? <Roles /> : <Navigate to="/employees" replace />}
            />
            <Route path="/hierarchy" element={page('hierarchy', <Hierarchy />)} />
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
            <Route path="/assets/dashboard" element={isAdmin ? <AssetDashboard /> : <Navigate to="/my-assets" replace />} />
            <Route path="/assets/renewals" element={isAdmin ? <AssetRenewals /> : <Navigate to="/my-assets" replace />} />
            <Route path="/assets/report" element={isAdmin ? <AssetReport /> : <Navigate to="/my-assets" replace />} />
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
          {/* Master: a destination, not a module, so it renders bare. */}
          <Route path="/masters" element={isAdmin ? <Masters /> : <Navigate to="/" replace />} />
          {/* The ERP Master card's lists, opened here rather than under /erp so the
              Master section stays put instead of switching to the ERP module. */}
          <Route
            path="/masters/erp/:tab"
            element={isAdmin ? <ErpMasters /> : <Navigate to="/" replace />}
          />
          {/* Organisation Master's two lists, each on its own page. Keyed so
              moving between them starts the page fresh on the right tab. */}
          <Route
            path="/departments"
            element={
              access.canViewTeam
                ? <DepartmentMaster />
                : <Navigate to="/employees" replace />
            }
          />
          <Route
            path="/designations"
            element={
              access.canViewTeam
                ? <DesignationMaster />
                : <Navigate to="/employees" replace />
            }
          />
          <Route
            path="/masters/:kind"
            element={isAdmin ? <MasterListPage /> : <Navigate to="/" replace />}
          />
          {(['sales', 'product'] as const).flatMap((g) => [
            <Route key={g} path={`/${g}-master`}
                   element={isAdmin ? <MasterHub key={g} groupKey={g} /> : <Navigate to="/" replace />} />,
            <Route key={`${g}-kind`} path={`/${g}-master/:kind`}
                   element={isAdmin ? <MasterHub key={g} groupKey={g} /> : <Navigate to="/" replace />} />,
          ])}

          <Route element={<ModulePanel group={mod('crm')} />}>
            <Route path="/crm" element={<LeadDashboard />} />
            <Route path="/crm/leads" element={<MyLeads />} />
            <Route path="/crm/leads/:leadId" element={<LeadDetail />} />
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
        )}
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
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
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

/** Shown in place of a page the person's role has no access to. */
function NoMenuAccess() {
  return (
    <div className="no-access">
      <span className="no-access-icon" aria-hidden>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
          <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
        </svg>
      </span>
      <h1>You don't have access to this page</h1>
      <p>Your role does not include this menu. Ask an administrator if you need it.</p>
      <Link className="btn btn-primary" to="/home">Go to home</Link>
    </div>
  )
}
