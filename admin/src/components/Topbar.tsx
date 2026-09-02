import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { locate, type NavAccess } from '../lib/nav'
import AccountMenu from './AccountMenu'
import AppLauncher from './AppLauncher'
import Brand from './Brand'
import CommandPalette from './CommandPalette'
import Notifications from './Notifications'
import { IconChevronRight, IconMenu, IconSearch } from './Icons'

/** ⌘ on a Mac, Ctrl everywhere else — the shortcut hint has to match the keys. */
const MOD = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl'

export default function Topbar({
  access,
  isAdmin,
  settingsHome,
  onOpenDrawer,
  drawerOpen,
}: {
  access: NavAccess
  isAdmin: boolean
  /** Where a bare /settings lands for this role, computed by the shell. */
  settingsHome: string
  onOpenDrawer: () => void
  drawerOpen: boolean
}) {
  const location = useLocation()
  const [paletteOpen, setPaletteOpen] = useState(false)

  const here = locate(location.pathname, access)

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

        {/* The whole product as a grid, leftmost, where every console that has
            one puts it. It earns its place twice over on a phone, where the
            rail is behind the drawer and this is the only view of the shape of
            the product. */}
        <AppLauncher access={access} />

        <div className="topbar-brand"><Brand size={26} /></div>

        {/* Where you are, one level above the page title, which says the same
            leaf word in 25px type. The group is the part that is not already
            on screen. */}
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link to="/" className="crumb crumb-root">Console</Link>
          {/* Skipped when the module and the page share a name. Noticeboard's
              first page is also called Noticeboard, and "Noticeboard ›
              Noticeboard" tells the reader nothing twice. */}
          {here?.heading && here.heading !== here.item.label && (
            <>
              <IconChevronRight size={14} />
              <span className="crumb crumb-muted">{here.heading}</span>
            </>
          )}
          {here && (
            <>
              <IconChevronRight size={14} />
              <span className="crumb crumb-here" aria-current="page">{here.item.label}</span>
            </>
          )}
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

        <span className="topbar-rule" aria-hidden="true" />

        <Notifications isAdmin={isAdmin} />

        {/* Appearance used to be a third icon button here and is now a labelled
            row inside this menu — see AccountMenu's header for why. */}
        <AccountMenu settingsHome={settingsHome} />
      </header>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} access={access} />
    </>
  )
}
