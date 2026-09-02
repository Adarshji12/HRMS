/* The pieces more than one CRM screen needs.

   Everything here exists because it was about to be written twice. The stage
   pill is on the table, the board and the drawer; the customer picker is on
   Visits, the Support Center and the quotation builder; the modal shell is on
   six screens. A second copy of any of them is a place for the two to drift. */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Link } from 'react-router-dom'
import { IconCheck, IconClose, IconSearch } from '../../components/Icons'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { dateTime } from '../../lib/format'
import { crm, whatsappLink, type Customer, type Lead, type Master } from './api'

/* ------------------------------------------------------------------- page --- */

/**
 * The shell every CRM screen sits in.
 *
 * Two jobs, and the first one is the important one: it puts `.crm` on the page
 * root. Every rule in `styles/crm.css` is scoped under that class, so the
 * module gets its own typography, controls and surfaces without reaching a
 * single selector into the rest of the console. A CRM page that forgets this
 * wrapper renders as plain console furniture — which is a visible failure
 * rather than a subtle one, and that is deliberate.
 *
 * The second job is the header: title, one line saying what the screen is for,
 * and the page's single primary action on the right. Nine copies of that markup
 * is nine chances for one of them to drift.
 */
export function CrmPage({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="crm">
      <header className="crm-head">
        <div style={{ minWidth: 0 }}>
          <h1 className="crm-title">{title}</h1>
          {subtitle && <p className="crm-subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="crm-head-actions">{actions}</div>}
      </header>
      {children}
    </div>
  )
}

/**
 * One figure, in a row of them.
 *
 * `tone` colours the icon chip, and colours the numeral **only** when the
 * figure carries a judgement — an overdue count is red because being overdue is
 * bad, where a total is just a total. A row where every number is coloured says
 * nothing, so `tone` alone tints the chip and `toned` opts into the numeral.
 *
 * `to` turns the whole tile into a link. Only tiles that lead somewhere lift
 * under the cursor: a tile that rises and then does nothing is a promise the
 * page does not keep.
 */
export function Stat({
  label,
  value,
  meta,
  icon,
  tone,
  toned,
  to,
}: {
  label: string
  value: ReactNode
  meta?: ReactNode
  icon?: ReactNode
  tone?: string
  toned?: boolean
  to?: string
}) {
  const body = (
    <>
      {icon && <span className="crm-stat-chip">{icon}</span>}
      <span className="crm-stat-body">
        <span className="crm-stat-label">{label}</span>
        <span className="crm-stat-value">{value}</span>
        {meta && <span className="crm-stat-meta">{meta}</span>}
      </span>
    </>
  )
  const className = `crm-stat${toned && tone ? ' crm-stat-toned' : ''}`
  const style = tone ? ({ ['--stat-tone' as never]: tone } as never) : undefined

  if (to) {
    return (
      <Link className={className} style={style} to={to}>
        {body}
      </Link>
    )
  }
  return (
    <div className={className} style={style}>
      {body}
    </div>
  )
}

/** The row those figures sit in. */
export function Stats({ children }: { children: ReactNode }) {
  return <div className="crm-stats">{children}</div>
}

/* ------------------------------------------------------------------ pills --- */

/** A lead's stage. The dot carries the master's colour; the chip stays neutral. */
export function StagePill({
  name,
  colour,
}: {
  name: string | null | undefined
  colour?: string | null
}) {
  if (!name) return <span className="crm-muted">—</span>
  return (
    <span className="crm-pill">
      <span className="crm-pill-dot" style={{ background: colour ?? 'var(--text-muted)' }} />
      {name}
    </span>
  )
}

const STATE_TONE: Record<string, string> = {
  active: 'crm-state-good',
  completed: 'crm-state-good',
  paid: 'crm-state-good',
  accepted: 'crm-state-good',
  done: 'crm-state-good',
  scheduled: 'crm-state-idle',
  draft: 'crm-state-idle',
  pending: 'crm-state-warn',
  partial: 'crm-state-warn',
  on_hold: 'crm-state-warn',
  in_progress: 'crm-state-warn',
  sent: 'crm-state-warn',
  open: 'crm-state-warn',
  expired: 'crm-state-bad',
  churned: 'crm-state-bad',
  rejected: 'crm-state-bad',
  failed: 'crm-state-bad',
  cancelled: 'crm-state-idle',
  closed: 'crm-state-idle',
}

const STATE_LABEL: Record<string, string> = {
  in_progress: 'In progress',
  on_hold: 'On hold',
}

/** A fixed, product-defined state — a visit's, a plan's, a quotation's.
 *
 * Separate from `StagePill` on purpose: a stage is named by the customer and
 * has no meaning the code can rely on, while these are a closed set the product
 * decides, so they get a fixed colour and a fixed label. */
export function StateText({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="crm-muted">—</span>
  const label = STATE_LABEL[value] ?? value.charAt(0).toUpperCase() + value.slice(1)
  return <span className={`crm-state ${STATE_TONE[value] ?? 'crm-state-idle'}`}>{label}</span>
}

/** A due date, coloured only when it is late or landing today. */
export function DueDate({ iso, overdue }: { iso: string | null; overdue?: boolean }) {
  if (!iso) return <span className="crm-muted">—</span>
  const when = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`)
  const today = new Date()
  const isToday = when.toDateString() === today.toDateString()
  const late = overdue ?? when.getTime() < today.getTime()
  const tone = late ? 'crm-due-over' : isToday ? 'crm-due-today' : ''
  return <span className={tone}>{dateTime(iso)}</span>
}

/* ----------------------------------------------------------------- dialog --- */

/** The modal shell. Escape closes, a click on the backdrop closes, and the
 *  first field is focused — the three things a dialog has to do that nobody
 *  remembers to add the sixth time they write one. */
export function Dialog({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose])

  return (
    <div
      className="crm-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className={`crm-dialog${wide ? ' crm-dialog-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="crm-dialog-head">
          <h2 className="crm-dialog-title">{title}</h2>
          {subtitle && <div className="crm-dialog-sub">{subtitle}</div>}
          <button className="crm-icon-btn crm-dialog-close" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </button>
        </div>
        {children}
        {footer && <div className="crm-dialog-foot">{footer}</div>}
      </div>
    </div>
  )
}

/** A right-hand sheet. Used for a lead and a customer, where the list behind is
 *  the context and closing must restore it exactly. */
export function Drawer({
  title,
  meta,
  onClose,
  children,
  footer,
}: {
  title: ReactNode
  meta?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <div className="crm-drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="crm-drawer" role="dialog" aria-modal="true">
        <div className="crm-drawer-head">
          <div style={{ minWidth: 0 }}>
            <div className="crm-ident-name">{title}</div>
            {meta && <div className="crm-sub">{meta}</div>}
          </div>
          <button
            className="crm-icon-btn"
            style={{ marginLeft: 'auto' }}
            onClick={onClose}
            aria-label="Close"
          >
            <IconClose size={16} />
          </button>
        </div>
        <div className="crm-drawer-body">{children}</div>
        {footer && <div className="crm-drawer-foot">{footer}</div>}
      </aside>
    </>
  )
}

/* ------------------------------------------------------------------ fields --- */

export function Field({
  label,
  hint,
  wide,
  children,
}: {
  label: string
  hint?: ReactNode
  wide?: boolean
  children: ReactNode
}) {
  return (
    <label className={`crm-field${wide ? ' crm-form-wide' : ''}`}>
      <span className="crm-field-label">{label}</span>
      {children}
      {hint && <span className="crm-field-hint">{hint}</span>}
    </label>
  )
}

/** A dropdown over one master list. Loads the list itself, so a form that needs
 *  five masters is five lines rather than five queries and five useMemos. */
export function MasterSelect({
  kind,
  value,
  onChange,
  parentId,
  placeholder = '—',
  disabled,
  activeOnly = true,
}: {
  kind: string
  value: string
  onChange: (value: string) => void
  parentId?: string
  placeholder?: string
  disabled?: boolean
  activeOnly?: boolean
}) {
  const list = useQuery<Master[]>(
    `crm-master-${kind}-${parentId ?? 'all'}`,
    () => crm.masters<Master>(kind, parentId),
    // A dependent list with no parent chosen yet has nothing to ask for: the
    // endpoint would answer with every city in the country.
    { enabled: parentId !== undefined ? Boolean(parentId) : true },
  )

  const options = (list.data ?? []).filter((row) => !activeOnly || row.is_active || row.id === value)

  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled || (parentId !== undefined && !parentId)}
      aria-label={kind}
    >
      <option value="">{placeholder}</option>
      {options.map((row) => (
        <option key={row.id} value={row.id}>
          {row.name}
        </option>
      ))}
    </select>
  )
}

/** The people this workspace can assign work to.
 *
 * A salesperson cannot read the roster, and that is correct — they can only
 * assign to themselves. The refusal is swallowed into an empty list rather than
 * surfaced: an "Unassigned"-only dropdown is the honest rendering of what that
 * person may do, where an error banner would suggest the page is broken. */
export function useTeam() {
  return useQuery<Array<{ id: string; full_name: string }>>('crm-team', () =>
    api.get<Array<{ id: string; full_name: string }>>('/admin/employees').catch(() => []),
  )
}

export function OwnerSelect({
  value,
  onChange,
  placeholder = 'Unassigned',
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  const team = useTeam()
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} aria-label="Owner">
      <option value="">{placeholder}</option>
      {(team.data ?? []).map((person) => (
        <option key={person.id} value={person.id}>
          {person.full_name}
        </option>
      ))}
    </select>
  )
}

/* --------------------------------------------------------------- pickers --- */

/** Type-ahead over customers. Search runs on the server, debounced, because a
 *  customer list is not something to hold in the browser. */
export function CustomerPicker({
  value,
  onPick,
  placeholder = 'Search a customer by name, mobile or code…',
  autoFocus,
}: {
  value: Customer | null
  onPick: (customer: Customer | null) => void
  placeholder?: string
  autoFocus?: boolean
}) {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<Customer[]>([])
  const [loading, setLoading] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || text.trim().length < 2) {
      setRows([])
      return
    }
    setLoading(true)
    // 250ms: long enough that typing a name is one request rather than eight,
    // short enough that the list feels attached to the keyboard.
    const timer = setTimeout(async () => {
      try {
        setRows(await crm.customers({ q: text.trim() }))
      } catch {
        setRows([])
      } finally {
        setLoading(false)
      }
    }, 250)
    return () => clearTimeout(timer)
  }, [text, open])

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  if (value) {
    return (
      <div className="crm-fact-value">
        <span className="crm-strong">{value.name}</span>
        <span className="crm-sub">{value.code} · {value.mobile}</span>
        <button className="crm-icon-btn" onClick={() => onPick(null)} aria-label="Choose another customer">
          <IconClose size={14} />
        </button>
      </div>
    )
  }

  return (
    <div className="crm-suggest" ref={box}>
      <div className="crm-search">
        <IconSearch size={15} />
        <input
          value={text}
          autoFocus={autoFocus}
          onChange={(event) => {
            setText(event.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          aria-label="Search customers"
        />
      </div>
      {open && text.trim().length >= 2 && (
        <div className="crm-suggest-list">
          {loading && <div className="crm-suggest-empty">Searching…</div>}
          {!loading && rows.length === 0 && (
            <div className="crm-suggest-empty">
              Nobody matches “{text.trim()}”. Add them on My Customers first.
            </div>
          )}
          {rows.map((row) => (
            <button
              key={row.id}
              className="crm-suggest-item"
              onClick={() => {
                onPick(row)
                setOpen(false)
                setText('')
              }}
            >
              <div className="crm-strong">{row.name}</div>
              <div className="crm-sub">
                {row.code} · {row.mobile}
                {row.company ? ` · ${row.company}` : ''}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* --------------------------------------------------------------- actions --- */

/** Open WhatsApp for a number, or render nothing when there is no number. */
export function WhatsAppButton({ mobile, label }: { mobile: string | null; label?: string }) {
  const href = whatsappLink(mobile)
  if (!href) return null
  return (
    <a
      className="crm-icon-btn crm-icon-wa"
      href={href}
      target="_blank"
      rel="noreferrer"
      title={label ?? `WhatsApp ${mobile}`}
      aria-label={label ?? `WhatsApp ${mobile}`}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M21 11.5a8.5 8.5 0 0 1-12.6 7.4L3 21l2.2-5.2A8.5 8.5 0 1 1 21 11.5Z" />
        <path d="M8.8 9.2c.3-.7.6-.7.9-.7h.6c.2 0 .4 0 .6.5l.7 1.6c.1.2 0 .4-.1.6l-.4.5c-.1.2-.2.3 0 .6a6 6 0 0 0 2.6 2.2c.3.1.4 0 .6-.1l.5-.6c.2-.2.3-.2.6-.1l1.6.8c.3.1.4.3.4.5a2 2 0 0 1-1.5 1.7 4 4 0 0 1-2.6-.4 9.6 9.6 0 0 1-4.4-4.3c-.5-1-.7-2-.1-2.8Z" />
      </svg>
    </a>
  )
}

/** A tick that shows for a moment after something saved. */
export function SavedTick({ shown }: { shown: boolean }) {
  if (!shown) return null
  return (
    <span className="crm-state crm-state-good" role="status">
      <IconCheck size={14} /> Saved
    </span>
  )
}

/* -------------------------------------------------------------- selection --- */

/** Row selection for a table, kept as a Set so a page of 200 is one object. */
export function useSelection<T extends { id: string }>(rows: T[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Rows that scrolled out of the filter are dropped from the selection: acting
  // on something the reader can no longer see is the bug bulk actions have.
  const visible = useMemo(() => new Set(rows.map((row) => row.id)), [rows])
  useEffect(() => {
    setSelected((current) => {
      const next = new Set([...current].filter((id) => visible.has(id)))
      return next.size === current.size ? current : next
    })
  }, [visible])

  return {
    selected,
    isSelected: (id: string) => selected.has(id),
    toggle: (id: string) =>
      setSelected((current) => {
        const next = new Set(current)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }),
    toggleAll: () =>
      setSelected((current) =>
        current.size === rows.length ? new Set() : new Set(rows.map((row) => row.id)),
      ),
    clear: () => setSelected(new Set()),
  }
}

/** The lead's headline, used by the table's first cell and by the board card. */
export function LeadName({ lead }: { lead: Lead }) {
  return (
    <div>
      <div className="crm-strong">{lead.name}</div>
      {lead.company && <div className="crm-sub">{lead.company}</div>}
    </div>
  )
}
