import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { locate, type NavAccess } from '../lib/nav'
import AccountMenu from './AccountMenu'
import Brand from './Brand'
import CommandPalette from './CommandPalette'
import Notifications from './Notifications'
import { LISTS, MASTER_GROUPS, shortLabel } from '../pages/masters/masterKit'
import { IconChevronRight, IconHome, IconMenu, IconSearch } from './Icons'

/* Pages that are destinations rather than entries of a module, so the nav
   cannot name them — the Master menu and the screens it opens. Each resolves
   to a trail, so the bar says which card and which list you are in:
   Master › Geography › State. Names come from masterKit, the same source
   the Master cards are drawn from, so the two cannot disagree. */
const byKind = new Map(LISTS.map((list) => [list.kind, list]))
const ERP_LISTS: Record<string, string> = {
  items: 'Items', warehouses: 'Warehouses', vendors: 'Vendors', customers: 'Customer accounts',
}

function masterTrail(path: string): string[] | null {
  const parts = path.split('/').filter(Boolean)
  if (parts[0] === 'masters') {
    if (parts.length === 1) return ['Master']
    if (parts[1] === 'erp') return ['Master', 'ERP Master', ERP_LISTS[parts[2]] ?? 'Lists']
    const kind = parts[1]
    const group = MASTER_GROUPS.find((g) => g.kinds.includes(kind))
    const list = byKind.get(kind)
    return ['Master', ...(group ? [group.title] : []), ...(list ? [shortLabel(list)] : [])]
  }
  if (parts[0] === 'departments') return ['Master', 'Organisation Master', 'Department']
  if (parts[0] === 'designations') return ['Master', 'Organisation Master', 'Designation']
  const own = MASTER_GROUPS.find((g) => g.path && path.startsWith(g.path))
  if (own) {
    const list = byKind.get(parts[1] ?? own.kinds[0])
    return ['Master', own.title, ...(list ? [shortLabel(list)] : [])]
  }
  return null
}

/** ⌘ on a Mac, Ctrl everywhere else — the shortcut hint has to match the keys. */
const MOD = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl'

export default function Topbar({
  access,
  isAdmin,
  settingsHome,
  onOpenDrawer,
  drawerOpen,
  onToggleRail,
  railCollapsed,
}: {
  access: NavAccess
  isAdmin: boolean
  /** Where a bare /settings lands for this role, computed by the shell. */
  settingsHome: string
  onOpenDrawer: () => void
  drawerOpen: boolean
  /** Desktop: collapse the rail to icons. The phone drawer has its own button. */
  onToggleRail?: () => void
  railCollapsed?: boolean
}) {
  const location = useLocation()
  const [paletteOpen, setPaletteOpen] = useState(false)

  const here = locate(location.pathname, access)

  /* Tracks the document, not a click: Esc and F11 leave fullscreen without
     going through this button, and the icon has to follow either way. */
  const [fullscreen, setFullscreen] = useState(() => !!document.fullscreenElement)
  useEffect(() => {
    const sync = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])
  const canFullscreen = typeof document.documentElement.requestFullscreen === 'function'
  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen().catch(() => {})
  }

  /* Mod+K from anywhere, and "/" when you are not already typing. Both are the
     conventions people arrive with; the second is skipped inside a field, where
     it is a character someone meant to type. */
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const modK = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k'
      const target = event.target as HTMLElement | null
      const typing =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      if (modK || (event.key === '/' && !typing)) {
        event.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <header className="topbar">
        {/* Phone only. It has to live outside the drawer, or the control that
            opens the drawer would travel away with it. */}
        <button
          className="icon-btn topbar-menu"
          onClick={onOpenDrawer}
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          aria-controls="primary-nav"
        >
          <IconMenu />
        </button>

        {onToggleRail && (
          <button
            className="icon-btn topbar-rail-toggle"
            onClick={onToggleRail}
            aria-label={railCollapsed ? 'Expand navigation' : 'Collapse navigation'}
            title={railCollapsed ? 'Expand navigation' : 'Collapse navigation'}
          >
            <IconMenu />
          </button>
        )}

        <div className="topbar-brand"><Brand size={26} /></div>

        {/* Where you are, one level above the page title, which says the same
            leaf word in 25px type. The group is the part that is not already
            on screen. */}
        <nav className="crumbs" aria-label="Breadcrumb">
          <span className="crumb-home" aria-hidden="true"><IconHome size={15} /></span>
          {/* Skipped when the module and the page share a name. Noticeboard's
              first page is also called Noticeboard, and "Noticeboard ›
              Noticeboard" tells the reader nothing twice. */}
          {here?.heading && here.heading !== here.item.label && (
            <>
              <span className="crumb crumb-muted">{here.heading}</span>
              <IconChevronRight size={14} />
            </>
          )}
          {here ? (
            <span className="crumb crumb-here" aria-current="page">{here.item.label}</span>
          ) : (masterTrail(location.pathname) ?? []).map((label, i, all) => (
            i < all.length - 1 ? (
              <span key={label} className="crumb-step">
                {i === 0
                  ? <Link className="crumb crumb-muted crumb-link" to="/masters">{label}</Link>
                  : <span className="crumb crumb-muted">{label}</span>}
                <IconChevronRight size={14} />
              </span>
            ) : (
              <span key={label} className="crumb crumb-here" aria-current="page">{label}</span>
            )
          ))}
        </nav>

        <div className="topbar-gap" />

        {/* A button dressed as a field, not a field. The palette owns the real
            input; two inputs would mean deciding which one has focus and
            keeping their values in step for no gain. */}
        <button className="search-trigger" onClick={() => setPaletteOpen(true)}>
          <IconSearch size={16} />
          <span className="search-trigger-text">Search…</span>
          <kbd className="kbd">{MOD} K</kbd>
        </button>
        <button
          className="icon-btn search-icon-btn"
          onClick={() => setPaletteOpen(true)}
          aria-label="Search"
        >
          <IconSearch size={18} />
        </button>

        <div className="topbar-actions">
          {canFullscreen && (
            <button
              className="icon-btn topbar-action"
              onClick={toggleFullscreen}
              aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
              title={fullscreen ? 'Exit full screen' : 'Full screen'}
            >
              {fullscreen ? <IconCollapse /> : <IconExpand />}
            </button>
          )}
          <Notifications isAdmin={isAdmin} />
          <Link
            to={settingsHome}
            className="icon-btn topbar-action"
            aria-label="Settings"
            title="Settings"
          >
            <IconCog />
          </Link>
        </div>

        <span className="topbar-rule" aria-hidden="true" />

        {/* Appearance used to be a third icon button here and is now a labelled
            row inside this menu — see AccountMenu's header for why. */}
        <AccountMenu settingsHome={settingsHome} />
      </header>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} access={access} />
    </>
  )
}

const glyph = {
  width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
}
function IconExpand() {
  return <svg {...glyph}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
}
function IconCollapse() {
  return <svg {...glyph}><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg>
}
function IconCog() {
  return (
    <svg {...glyph}>
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}
