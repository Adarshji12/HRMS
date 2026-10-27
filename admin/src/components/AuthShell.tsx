/**
 * The frame around every signed-out screen — sign-in, signup, and signup's
 * finished page.
 *
 * Form on the left, the product on the right. The right panel is the same on
 * every one of these screens on purpose: a prospect moving from "Create a
 * workspace" to "Sign in" should feel they have stayed in one place, and the
 * picture is the one-line pitch — every part of the business wired into one
 * hub — said without a paragraph.
 *
 * The illustration is inline SVG plus positioned HTML chips rather than an
 * image file: it stays crisp at any size, follows the brand tokens, and the
 * module names are real text a screen reader can skip as decoration.
 */
import { useEffect, type ReactNode } from 'react'
import Brand from './Brand'
import '../styles/auth.css'

const MODULES: Array<{ label: string; sub: string; x: number; y: number; icon: ReactNode }> = [
  { label: 'HR & People', sub: '248 employees', x: 16, y: 16, icon: <PeopleIcon /> },
  { label: 'Payroll', sub: 'Run in 4 min', x: 84, y: 16, icon: <WalletIcon /> },
  { label: 'Attendance', sub: 'Geo-fenced', x: 8, y: 52, icon: <ClockIcon /> },
  { label: 'CRM & Sales', sub: '32 open deals', x: 92, y: 52, icon: <ChartIcon /> },
  { label: 'Inventory', sub: '3 warehouses', x: 16, y: 88, icon: <BoxIcon /> },
  { label: 'Finance', sub: 'GST ready', x: 84, y: 88, icon: <LedgerIcon /> },
]

export default function AuthShell({
  children,
  wide,
}: {
  children: ReactNode
  /** The signup wizard lays fields out in pairs and needs the room. */
  wide?: boolean
}) {
  /* One sign-in page, whatever the console's theme. The signed-out screens
     are designed light — the showcase is the dark half — and a dark form
     beside a dark showcase reads as a different product. The person's own
     choice comes back the moment they leave. */
  useEffect(() => {
    const root = document.documentElement
    const previous = root.getAttribute('data-theme')
    root.setAttribute('data-theme', 'light')
    return () => {
      if (previous === null) root.removeAttribute('data-theme')
      else root.setAttribute('data-theme', previous)
    }
  }, [])

  return (
    <div className={`auth${wide ? ' auth-wide' : ''}`}>
      <main className="auth-form-side">
        <header className="auth-top"><Brand size={34} /></header>
        <div className="auth-form-inner">{children}</div>
        <footer className="auth-legal">
          <span>© {new Date().getFullYear()} LRS Services</span>
          <span className="auth-secure"><LockIcon /> 256-bit encrypted · Data stays in India</span>
        </footer>
      </main>
      <Showcase />
    </div>
  )
}

function Showcase() {
  return (
    <aside className="auth-showcase" aria-hidden>
      <div className="auth-showcase-grid" />
      <div className="auth-showcase-content">
        <span className="auth-eyebrow">One connected business</span>
        <h2 className="auth-headline">
          People, finance and operations —<br />
          <span>running on one ERP.</span>
        </h2>
        <p className="auth-tagline">
          HR, payroll, attendance, sales, inventory and accounts share one record,
          so every approval, payslip and invoice is already in sync.
        </p>

        <div className="auth-hub">
          <svg className="auth-hub-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
            <defs>
              <linearGradient id="auth-line" x1="0" x2="1">
                <stop offset="0" stopColor="#18b8e0" stopOpacity="0.15" />
                <stop offset="1" stopColor="#18b8e0" stopOpacity="0.9" />
              </linearGradient>
            </defs>
            {MODULES.map((m) => (
              <g key={m.label}>
                <line x1={m.x} y1={m.y} x2="50" y2="52" className="auth-line-base" />
                <line x1={m.x} y1={m.y} x2="50" y2="52" className="auth-line-flow" />
              </g>
            ))}
          </svg>

          <div className="auth-core">
            <span className="auth-core-ring" />
            <span className="auth-core-ring auth-core-ring-2" />
            <div className="auth-core-disc">
              <HubIcon />
              <strong>ERP</strong>
              <small>Core</small>
            </div>
          </div>

          {MODULES.map((m, i) => (
            <div key={m.label} className="auth-node" style={{ left: `${m.x}%`, top: `${m.y}%`, animationDelay: `${i * 0.4}s` }}>
              <span className="auth-node-icon">{m.icon}</span>
              <span className="auth-node-text">
                <strong>{m.label}</strong>
                <small>{m.sub}</small>
              </span>
            </div>
          ))}

          <div className="auth-toast auth-toast-a">
            <span className="auth-toast-dot" /> Payroll for October approved
          </div>
          <div className="auth-toast auth-toast-b">
            <span className="auth-toast-dot auth-toast-dot-b" /> PO-1042 synced to inventory
          </div>
        </div>

        <ul className="auth-points">
          <li><CheckIcon /> Role-based access and full audit trail</li>
          <li><CheckIcon /> Multi-level approvals across every module</li>
          <li><CheckIcon /> PF, ESI, TDS and GST built in</li>
        </ul>
      </div>
    </aside>
  )
}

/* ----------------------------------------------------------------- icons --- */

const svg = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

function PeopleIcon() { return <svg {...svg}><circle cx="9" cy="8" r="3.2" /><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5" /><circle cx="17" cy="9" r="2.4" /><path d="M16 14.2c2.4.2 4.3 1.8 4.9 4.8" /></svg> }
function WalletIcon() { return <svg {...svg}><rect x="3" y="6" width="18" height="13" rx="2.5" /><path d="M3 10h18" /><circle cx="16.5" cy="14.5" r="1.2" /></svg> }
function ClockIcon() { return <svg {...svg}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg> }
function ChartIcon() { return <svg {...svg}><path d="M4 19V5" /><path d="M4 19h16" /><path d="M7.5 15l3.5-4 3 2.5L19 8" /></svg> }
function BoxIcon() { return <svg {...svg}><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5" /><path d="M12 12v9" /></svg> }
function LedgerIcon() { return <svg {...svg}><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h3" /></svg> }
function HubIcon() { return <svg {...svg} width={26} height={26}><circle cx="12" cy="12" r="3" /><circle cx="5" cy="5" r="1.6" /><circle cx="19" cy="5" r="1.6" /><circle cx="5" cy="19" r="1.6" /><circle cx="19" cy="19" r="1.6" /><path d="M6.2 6.2l3.6 3.6M17.8 6.2l-3.6 3.6M6.2 17.8l3.6-3.6M17.8 17.8l-3.6-3.6" /></svg> }
function CheckIcon() { return <svg {...svg} width={16} height={16} strokeWidth={2.2}><path d="M5 12.5l4.2 4L19 7" /></svg> }
function LockIcon() { return <svg {...svg} width={13} height={13}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></svg> }

export function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg {...svg}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></svg>
  ) : (
    <svg {...svg}><path d="M3 3l18 18" /><path d="M10.6 6.1A9.6 9.6 0 0112 6c6 0 9.5 6 9.5 6a17 17 0 01-3.2 3.9M6.6 7.6C4 9.4 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1" /><path d="M9.9 10a3 3 0 004.1 4.1" /></svg>
  )
}
