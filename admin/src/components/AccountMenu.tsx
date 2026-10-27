import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useTheme, type ThemeMode } from '../lib/theme'
import { Avatar } from './ui'
import { IconBell, IconGear, IconMonitor, IconMoon, IconSignOut, IconSun, IconUsers } from './Icons'

const MODES: Array<{ id: ThemeMode; label: string; icon: (p: { size?: number }) => JSX.Element }> = [
  { id: 'light', label: 'Light', icon: IconSun },
  { id: 'dark', label: 'Dark', icon: IconMoon },
  { id: 'system', label: 'System', icon: IconMonitor },
]

/**
 * Who is signed in, and the three things they do about it.
 *
 * The rail's footer already carries the name, the workspace and a sign-out, and
 * this does not replace it — it puts them where a reader looks for them, at the
 * top right, and where they are still reachable with the rail collapsed to
 * icons or shut behind a phone drawer.
 *
 * Appearance moved in here from its own topbar button. As a bare icon that
 * cycled three states it was a control you had to press twice to learn: the
 * glyph told you the mode you were already in, never the one the next press
 * would give you. Three labelled radio rows say the whole thing at once and
 * cost the bar one button.
 */
export default function AccountMenu({ settingsHome }: { settingsHome: string }) {
  const { user, organization, logout } = useAuth()
  const { mode, setMode } = useTheme()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const name = user?.full_name ?? 'Account'

  return (
    <div className="account" ref={wrapRef}>
      <button
        ref={buttonRef}
        className={`account-btn${open ? ' account-btn-on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Account: ${name}`}
      >
        <Avatar name={name} small />
        <span className="account-btn-text">
          <span className="account-btn-name">{name}</span>
          <span className="account-btn-role">{user?.role_name ?? user?.role}</span>
        </span>
        <svg className="account-btn-caret" width="14" height="14" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="popover account-panel" role="dialog" aria-label="Account">
          <div className="account-id">
            <Avatar name={name} />
            <div className="account-id-text">
              <div className="account-id-name">{name}</div>
              <div className="account-id-meta">{user?.email}</div>
              {organization && <div className="account-id-org">{organization.name}</div>}
            </div>
          </div>

          <div className="account-links">
            <Link to="/profile" className="account-link" onClick={() => setOpen(false)}>
              <IconUsers size={15} /> My profile
            </Link>
            <Link to="/settings/notifications" className="account-link" onClick={() => setOpen(false)}>
              <IconBell size={15} /> Notification settings
            </Link>
            {/* Wherever a bare /settings lands for this role — an employee holds
                none of the administration pages, so the target is computed by
                the shell rather than fixed here. */}
            <Link to={settingsHome} className="account-link" onClick={() => setOpen(false)}>
              <IconGear size={15} /> Settings
            </Link>
          </div>

          <div className="account-theme" role="radiogroup" aria-label="Appearance">
            <span className="account-theme-label">Appearance</span>
            <div className="account-theme-row">
              {MODES.map((option) => {
                const Glyph = option.icon
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={mode === option.id}
                    className={`account-theme-opt${mode === option.id ? ' account-theme-on' : ''}`}
                    onClick={() => setMode(option.id)}
                  >
                    <Glyph size={15} />
                    {option.label}
                  </button>
                )
              })}
            </div>
          </div>

          <button className="account-link account-signout" onClick={logout}>
            <IconSignOut size={15} /> Sign out
          </button>
        </div>
      )}
    </div>
  )
}
