import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { firstRouteIn, moduleOf, topLevelItems, visibleModules, type NavAccess } from '../lib/nav'
import { IconGrid } from './Icons'

/**
 * The nine-dot module launcher.
 *
 * A second way into the same twelve modules the rail already lists, and worth
 * having for one reason: the rail is a column of 34px rows read one at a time,
 * and this is a grid read at a glance. On a phone the rail is behind a drawer
 * and this is the only place the shape of the product is visible at all.
 *
 * It invents nothing. Every tile is a module from `nav.tsx` — the single source
 * of truth for the rail, the breadcrumb, the palette and now this — pointed at
 * `firstRouteIn`, the first page the signed-in person can actually open, so a
 * tile is never a link into a permission bounce. A module nobody in this role
 * can open has no tile rather than a disabled one.
 */
export default function AppLauncher({ access }: { access: NavAccess }) {
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  /* The two destinations that are not modules, then the modules in rail order.
     Both halves go through the same access filter the rail uses. */
  const destinations = topLevelItems(access)
  const modules = visibleModules(access)
  const here = moduleOf(location.pathname, access)

  useEffect(() => {
    if (!open) return
    function onDown(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setOpen(false)
      // Escape has to leave focus somewhere sensible, and the trigger is where
      // it came from.
      buttonRef.current?.focus()
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // A launcher left open over the page it just opened is the same dead end the
  // phone drawer would be.
  useEffect(() => setOpen(false), [location.pathname])

  return (
    <div className="launcher" ref={wrapRef}>
      <button
        ref={buttonRef}
        className={`icon-btn launcher-btn${open ? ' launcher-btn-on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label="All modules"
        aria-expanded={open}
        title="All modules"
      >
        <IconGrid size={18} />
      </button>

      {open && (
        <div className="launcher-panel" role="dialog" aria-label="All modules">
          {destinations.length > 0 && (
            <div className="launcher-rail">
              {destinations.map((item) => (
                <Link key={item.to} to={item.to} className="launcher-pill">
                  <item.icon size={15} />
                  {item.label}
                </Link>
              ))}
            </div>
          )}

          <div className="launcher-grid">
            {modules.map((group) => {
              const to = firstRouteIn(group, access)
              if (!to) return null
              const Glyph = group.icon!
              /* Lit for the whole module, matching the rail — the tile points
                 at the module's first page but the reader is somewhere in the
                 module, and a tile that goes dark on the second page would be
                 telling them they had left it. */
              const current = here?.key === group.key
              return (
                <Link
                  key={group.key}
                  to={to}
                  className="launcher-tile"
                  aria-current={current ? 'page' : undefined}
                >
                  <span className="launcher-glyph"><Glyph size={19} /></span>
                  <span className="launcher-label">{group.heading}</span>
                </Link>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
