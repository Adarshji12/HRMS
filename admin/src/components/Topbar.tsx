import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { locate, type NavAccess } from '../lib/nav'
import { useTheme, type ThemeMode } from '../lib/theme'
import Brand from './Brand'
import CommandPalette from './CommandPalette'
import Notifications from './Notifications'
import {
  IconChevronRight,
  IconMenu,
  IconMonitor,
  IconMoon,
  IconSearch,
  IconSun,
} from './Icons'

const THEME_ICON: Record<ThemeMode, (p: { size?: number }) => JSX.Element> = {
  system: IconMonitor,
  light: IconSun,
  dark: IconMoon,
}
const THEME_LABEL: Record<ThemeMode, string> = {
  system: 'Appearance: follow system',
  light: 'Appearance: light',
  dark: 'Appearance: dark',
}

/** ⌘ on a Mac, Ctrl everywhere else — the shortcut hint has to match the keys. */
const MOD = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl'

export default function Topbar({
  access,
  isAdmin,
  onOpenDrawer,
  drawerOpen,
}: {
  access: NavAccess
  isAdmin: boolean
  onOpenDrawer: () => void
  drawerOpen: boolean
}) {
  const location = useLocation()
  const { mode, cycle } = useTheme()
  const [paletteOpen, setPaletteOpen] = useState(false)

  const here = locate(location.pathname, access)
  const ThemeGlyph = THEME_ICON[mode]

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
        <div className="topbar-brand"><Brand size={26} /></div>

        {/* Where you are, one level above the page title, which says the same
            leaf word in 25px type. The group is the part that is not already
            on screen. */}
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link to="/" className="crumb crumb-root">Console</Link>
          {here?.heading && (
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

        <button className="icon-btn" onClick={cycle} aria-label={THEME_LABEL[mode]} title={THEME_LABEL[mode]}>
          <ThemeGlyph size={18} />
        </button>

        <Notifications isAdmin={isAdmin} />
      </header>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} access={access} />
    </>
  )
}
