import { NavLink, Outlet } from 'react-router-dom'
import { canAdminister, canApproveSomething, canViewTeam, isOwner, useAuth } from '../lib/auth'
import { sectionsIn, type NavGroup } from '../lib/nav'
import '../styles/panel.css'

/**
 * A module, with its pages along a bar above them.
 *
 * The sidebar used to carry every page in the product — about fifty rows for an
 * administrator, behind collapsible headings. The second level moved out of
 * that 244px column and onto a horizontal bar at the top of the content, which
 * is where the reader is already looking and where a label has room to be a
 * phrase rather than a truncated word.
 *
 * It is one component for eleven modules rather than eleven layouts: the only
 * thing that differs between them is the NavGroup, and a bespoke layout per
 * module is eleven places to forget a permission filter.
 *
 * The pages inside are untouched — each still renders its own `.page-head`, so
 * it keeps the title and the explanatory line it always had. This supplies only
 * the way in.
 */
export default function ModulePanel({ group }: { group: NavGroup }) {
  const { user } = useAuth()
  const access = {
    isAdmin: canAdminister(user),
    canViewTeam: canViewTeam(user),
    isOwner: isOwner(user),
    canApprove: canApproveSomething(user),
    hiddenPages: user?.hidden_pages ?? [],
    menuRights: user?.menu_rights ?? null,
  }

  const sections = sectionsIn(group, access)
  const total = sections.reduce((n, s) => n + s.items.length, 0)

  /* One page is not a navbar. A bar holding the single page you are already
     looking at is chrome answering a question nobody asked — and it happens for
     real: an employee's Settings is Notifications alone, and their Payroll
     narrows to the self-service rows only because the admin ones are filtered
     out. Below two, render the page and let it speak for itself. */
  if (total <= 1) return <Outlet />

  return (
    <div className={`page pnl-shell${group.key === 'crm' ? ' pnl-crm-shell' : ''}`}>
      <nav className="pnl-bar" aria-label={`${group.heading} pages`}>
        {sections.map((section, index) => (
          /* The group's name is carried by role+aria-label rather than a caps
             label on the bar. Printed, it was a third row of shouting text
             above navigation that already names itself — "COMPANY Employees
             Hierarchy" reads as four links, not a heading and three. The gap
             between sets is what separates them now; screen readers still get
             the name. */
          <span
            className="pnl-set"
            key={section.heading ?? index}
            {...(section.heading ? { role: 'group', 'aria-label': section.heading } : {})}
          >
            {section.items.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className="pnl-tab">
                <item.icon size={15} />
                {item.label}
              </NavLink>
            ))}
          </span>
        ))}
      </nav>

      <div className="pnl-body">
        <Outlet />
      </div>
    </div>
  )
}
