/* My Customers — everyone who bought, from conversion to renewal.
 *
 * The list is a renewal list first and a directory second, because that is the
 * question people actually open it with: who is about to lapse. So the tiles
 * count renewal windows rather than restating the row count, and the table's
 * loudest column is the renewal date.
 *
 * A customer's plans live in the drawer rather than on a page of their own.
 * They are only ever read *about* a customer — nobody asks "show me all the
 * plans" — and a separate route would mean losing the list you were working
 * through to add one line.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import '../../styles/crm.css'
import '../../styles/hrdash.css'
import '../../styles/leads.css'
import { useQuery } from '../../lib/useQuery'
import { Avatar, EmptyState, ErrorNote, Loading } from '../../components/ui'
import {
  IconAlert,
  IconArrowLeft,
  IconBriefcase,
  IconBuilding,
  IconCalendar,
  IconCard,
  IconCheck,
  IconClock,
  IconClose,
  IconDownload,
  IconEdit,
  IconFilter,
  IconMail,
  IconPhone,
  IconPin,
  IconPlus,
  IconReturn,
  IconSearch,
  IconSheet,
  IconTrash,
  IconUpload,
  IconUser,
  IconUsers,
} from '../../components/Icons'
import {
  crm,
  crmError,
  inDays,
  localToISO,
  rupees,
  todayISO,
  type Customer,
  type CustomerDetail,
  type CustomerPlan,
} from './api'
import {
  CrmPage,
  Dialog,
  Field,
  LfField,
  LfInput,
  LfSection,
  MasterSelect,
  OwnerSelect,
  StateText,
  WhatsAppButton,
} from './parts'

type Created = '' | 'today' | '7d' | '30d' | 'year'

function inCreated(iso: string, created: Created): boolean {
  if (!created) return true
  const when = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`)
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  if (created === '7d') start.setDate(start.getDate() - 6)
  if (created === '30d') start.setDate(start.getDate() - 29)
  if (created === 'year') start.setMonth(0, 1)
  return when >= start
}

export default function MyCustomers() {
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [renewal, setRenewal] = useState('')
  const [managerId, setManagerId] = useState('')
  const [adding, setAdding] = useState(false)
  const [openId, setOpenId] = useState<string | null>(params.get('open'))
  const [rowError, setRowError] = useState<string | null>(null)
  const [created, setCreated] = useState<Created>('')
  const [typeF, setTypeF] = useState('')
  const [industryF, setIndustryF] = useState('')
  const [sourceF, setSourceF] = useState('')
  const [stateF, setStateF] = useState('')
  const [cityF, setCityF] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [importing, setImporting] = useState(false)
  const filterRef = useRef<HTMLDivElement>(null)

  /* The Filters popover closes on a click outside it or on Escape. */
  useEffect(() => {
    if (!showFilters) return
    const onDown = (e: MouseEvent) => {
      if (!filterRef.current?.contains(e.target as Node)) setShowFilters(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowFilters(false) }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [showFilters])

  const rows = useQuery<Customer[]>(
    `crm-customers-${q}-${status}-${renewal}-${managerId}`,
    () =>
      crm.customers({
        q: q.trim() || undefined,
        status: status || undefined,
        renewal: renewal || undefined,
        manager_id: managerId || undefined,
      }),
  )

  // Counters read the unfiltered list, so switching the "renewal due" filter on
  // does not change the number the filter is counting.
  const all = useQuery<Customer[]>('crm-customers-all', () => crm.customers({}))
  /* The server filters by search, status, manager and renewal; the date and
     the popover's fields are applied here to the list it returned, which is
     the whole roster rather than a page of it. */
  const list = (rows.data ?? []).filter((row) =>
    inCreated(row.created_at, created) &&
    (!typeF || row.customer_type === typeF) &&
    (!industryF || row.industry_id === industryF) &&
    (!sourceF || row.source_id === sourceF) &&
    (!stateF || row.state_id === stateF) &&
    (!cityF || row.city_id === cityF))
  const moreCount = [renewal, typeF, industryF, sourceF, stateF, cityF].filter(Boolean).length
  const filtered = Boolean(q || status || managerId || created || moreCount)
  const clearAll = () => {
    setQ(''); setStatus(''); setRenewal(''); setManagerId(''); setCreated('')
    setTypeF(''); setIndustryF(''); setSourceF(''); setStateF(''); setCityF('')
  }

  function exportCsv() {
    const cols: Array<[string, (c: Customer) => string]> = [
      ['Customer ID', (c) => c.code], ['Name', (c) => c.name], ['Company', (c) => c.company ?? ''],
      ['Mobile', (c) => c.mobile], ['Email', (c) => c.email ?? ''], ['Type', (c) => c.customer_type ?? ''],
      ['Industry', (c) => c.industry_name ?? ''], ['Source', (c) => c.source_name ?? ''],
      ['City', (c) => c.city_name ?? ''], ['State', (c) => c.state_name ?? ''],
      ['Manager', (c) => c.manager_name ?? ''], ['Status', (c) => c.status],
      ['Plan', (c) => c.primary_plan?.product_name ?? ''], ['Renewal', (c) => c.primary_plan?.renewal_on ?? ''],
      ['Added', (c) => c.created_at.slice(0, 10)],
    ]
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`
    const text = [cols.map(([h]) => esc(h)).join(','), ...list.map((c) => cols.map(([, f]) => esc(f(c))).join(','))].join('\r\n')
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `customers-${todayISO()}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }
  const everyone = all.data ?? []
  const dueSoon = everyone.filter(
    (row) =>
      row.primary_plan?.days_to_renewal !== null &&
      row.primary_plan?.days_to_renewal !== undefined &&
      row.primary_plan.days_to_renewal >= 0 &&
      row.primary_plan.days_to_renewal <= 30,
  ).length
  const expired = everyone.filter(
    (row) =>
      row.primary_plan?.days_to_renewal !== null &&
      row.primary_plan?.days_to_renewal !== undefined &&
      row.primary_plan.days_to_renewal < 0,
  ).length

  async function remove(row: Customer) {
    if (!window.confirm(`Delete the customer “${row.name}” with its plans, follow-ups and visits? This cannot be undone.`)) return
    setRowError(null)
    try {
      await crm.deleteCustomer(row.id)
      rows.reload()
      all.reload()
    } catch (err) {
      setRowError(crmError(err, 'That customer could not be deleted'))
    }
  }

  if (openId) {
    const close = () => {
      setOpenId(null)
      if (params.get('open')) setParams({}, { replace: true })
    }
    const changed = () => {
      rows.reload()
      all.reload()
    }
    return (
      <CustomerProfile key={openId} customerId={openId} onBack={close} onChanged={changed}
        onDelete={async (c) => {
          if (!window.confirm(`Delete ${c.name}? Their plans, calls and follow-ups go with them. This cannot be undone.`)) return
          try {
            await crm.deleteCustomer(c.id)
            changed()
            close()
          } catch (err) {
            window.alert(crmError(err, 'That customer could not be deleted'))
          }
        }} />
    )
  }

  if (rows.error && !rows.data) {
    return (
      <CrmPage title="My Customers">
        <ErrorNote>{crmError(rows.cause, 'Could not load your customers')}</ErrorNote>
      </CrmPage>
    )
  }

  const active = everyone.filter((row) => row.status === 'active').length
  const types = [...new Set(everyone.map((row) => row.customer_type).filter((t): t is string => Boolean(t)))].sort()
  const onHold = everyone.filter((row) => row.status === 'on_hold').length

  // The HR Dashboard's KPI cards. Renewal and expiry only turn amber or red
  // when there is something to act on — a red zero is an alarm about nothing.
  const kpis: Array<{ label: string; value: number; hint: string; tone: string; icon: ReactNode; pick?: () => void }> = [
    { label: 'Customers', value: everyone.length, hint: 'Everyone who bought', tone: 'brand', icon: <IconUsers size={16} />,
      pick: () => { setStatus(''); setRenewal('') } },
    { label: 'Active', value: active, hint: everyone.length ? `${Math.round((active / everyone.length) * 100)}% of customers` : 'No customers yet',
      tone: 'good', icon: <IconCheck size={16} />, pick: () => { setStatus('active'); setRenewal('') } },
    { label: 'Renewal due', value: dueSoon, hint: dueSoon ? 'Within 30 days' : 'Nothing lapsing', tone: dueSoon > 0 ? 'warn' : 'idle',
      icon: <IconClock size={16} />, pick: () => { setStatus(''); setRenewal('due') } },
    { label: 'Expired', value: expired, hint: expired ? 'Renewal date passed' : 'All plans current', tone: expired > 0 ? 'bad' : 'idle',
      icon: <IconAlert size={16} />, pick: () => { setStatus(''); setRenewal('expired') } },
    { label: 'On hold', value: onHold, hint: 'Paused accounts', tone: 'idle', icon: <IconReturn size={16} />,
      pick: () => { setStatus('on_hold'); setRenewal('') } },
  ]

  return (
    <div className="crm hrd">
      {/* Each card is also a filter: a number you can click straight into. */}
      <div className="hrd-kpis erd-kpis" role="group" aria-label="Customer summary">
        {kpis.map((k) => (
          <button key={k.label} type="button" className={`hrd-kpi tone-${k.tone} cu-kpi`} onClick={k.pick}>
            <span className="hrd-kpi-top">
              <span className="hrd-kpi-label">{k.label}</span>
              <span className="hrd-kpi-icon" aria-hidden>{k.icon}</span>
            </span>
            <span className="hrd-kpi-value">{k.value}</span>
            <span className="hrd-kpi-hint">{k.hint}</span>
          </button>
        ))}
      </div>

      {/* One toolbar: search and the everyday filters, the rest behind
          Filters, then export, import and Add Customer. */}
      <div className="crm-bar ml-toolbar cu-toolbar">
        <div className="crm-search">
          <IconSearch size={15} />
          <input
            type="search"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Search ID, name, company, mobile, email…"
            aria-label="Search customers"
          />
        </div>
        <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Status">
          <option value="">All Statuses</option>
          <option value="active">Active</option>
          <option value="on_hold">On hold</option>
          <option value="expired">Expired</option>
          <option value="churned">Churned</option>
        </select>
        <label className="cu-date" title="When the customer was added">
          <IconCalendar size={14} />
          <select value={created} onChange={(event) => setCreated(event.target.value as Created)} aria-label="Added">
            <option value="">All time</option>
            <option value="today">Today</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="year">This year</option>
          </select>
        </label>
        <OwnerSelect value={managerId} onChange={setManagerId} placeholder="All Managers" />

        <div className="ml-filter" ref={filterRef}>
          <button
            className={`crm-tab ml-filter-btn${moreCount ? ' is-active' : ''}${showFilters ? ' is-open' : ''}`}
            onClick={() => setShowFilters((open) => !open)}
            aria-expanded={showFilters}
            aria-haspopup="dialog"
          >
            <IconFilter size={14} /> Filters
            {moreCount > 0 && <span className="ml-filter-count">{moreCount}</span>}
          </button>
          {showFilters && (
            <div className="ml-pop cu-pop" role="dialog" aria-label="Filter customers">
              <label className="ml-pop-field">
                <span>Renewal</span>
                <select value={renewal} onChange={(event) => setRenewal(event.target.value)}>
                  <option value="">Any renewal</option>
                  <option value="due">Due in 30 days</option>
                  <option value="expired">Renewal passed</option>
                </select>
              </label>
              <label className="ml-pop-field">
                <span>Customer type</span>
                <select value={typeF} onChange={(event) => setTypeF(event.target.value)}>
                  <option value="">All types</option>
                  {types.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label className="ml-pop-field">
                <span>Industry</span>
                <MasterSelect kind="industries" value={industryF} onChange={setIndustryF} placeholder="All industries" />
              </label>
              <label className="ml-pop-field">
                <span>Source</span>
                <MasterSelect kind="sources" value={sourceF} onChange={setSourceF} placeholder="All sources" />
              </label>
              <label className="ml-pop-field">
                <span>State</span>
                <MasterSelect kind="states" value={stateF} placeholder="All states"
                              onChange={(v) => { setStateF(v); setCityF('') }} />
              </label>
              <label className="ml-pop-field">
                <span>City</span>
                <MasterSelect kind="cities" parentId={stateF} value={cityF} onChange={setCityF} placeholder="All cities" />
              </label>
              <button type="button" className="ml-pop-reset" disabled={moreCount === 0}
                      onClick={() => { setRenewal(''); setTypeF(''); setIndustryF(''); setSourceF(''); setStateF(''); setCityF('') }}>
                Reset filters
              </button>
            </div>
          )}
        </div>

        {filtered && (
          <button className="filter-reset" onClick={clearAll}>
            <IconClose size={13} /> Clear
          </button>
        )}

        <span className="crm-push" />
        <button className="ml-icon-btn" onClick={exportCsv} disabled={list.length === 0}
                title="Export this view as CSV" aria-label="Export this view as CSV">
          <IconDownload size={15} />
        </button>
        <button className="ml-icon-btn" onClick={() => setImporting(true)}
                title="Import customers from a CSV file" aria-label="Import customers from a CSV file">
          <IconUpload size={15} />
        </button>
        <button className="btn btn-primary ml-add" onClick={() => setAdding(true)}>
          <IconPlus size={14} /> Add Customer
        </button>
      </div>

      {rowError && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{rowError}</ErrorNote>
        </div>
      )}

      <section className="hrd-panel" style={{ opacity: rows.refetching ? 0.6 : 1 }}>
        {list.length === 0 ? (
          rows.loading ? (
            <Loading />
          ) : (
            <EmptyState
              icon={<IconUsers size={22} />}
              title="No customers yet"
              body="Convert a lead once they buy, or add an existing account by hand. Everything else in the CRM — visits, support calls, renewals — hangs off a customer record."
              action={
                <button className="btn btn-primary" onClick={() => setAdding(true)}>
                  Add the first customer
                </button>
              }
            />
          )
        ) : (
          <>
            <div className="table-wrap">
              <table className="crm-table-wide">
                <thead>
                  <tr>
                    <th>Customer ID</th>
                    <th>Customer</th>
                    <th>Mobile</th>
                    <th>Product / Plan</th>
                    <th>Plan period</th>
                    <th>Renewal</th>
                    <th>Manager</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((row) => (
                    <tr key={row.id}>
                      <td className="crm-code">{row.code}</td>
                      <td>
                        <button className="link-btn cu-person" onClick={() => setOpenId(row.id)}>
                          <Avatar name={row.name} small />
                          <span>
                            <span className="crm-strong">{row.name}</span>
                            {row.company && <span className="crm-sub">{row.company}</span>}
                          </span>
                        </button>
                      </td>
                      <td className="crm-nowrap">
                        <WhatsAppButton mobile={row.whatsapp ?? row.mobile} />
                        {row.mobile}
                      </td>
                      <td>
                        {row.primary_plan ? (
                          <>
                            <span className="crm-pill">{row.primary_plan.product_name}</span>
                            {row.primary_plan.plan_name && (
                              <div className="crm-sub">{row.primary_plan.plan_name}</div>
                            )}
                            {row.plan_count > 1 && (
                              <div className="crm-sub">+{row.plan_count - 1} more</div>
                            )}
                          </>
                        ) : (
                          <span className="crm-muted">Nothing recorded</span>
                        )}
                      </td>
                      <td className="crm-nowrap crm-sub">
                        {row.primary_plan
                          ? `${row.primary_plan.start_on} → ${row.primary_plan.end_on ?? 'perpetual'}`
                          : '—'}
                      </td>
                      <td className="crm-nowrap">
                        {row.primary_plan?.renewal_on ?? <span className="crm-muted">—</span>}
                        {row.primary_plan?.days_to_renewal !== null &&
                          row.primary_plan?.days_to_renewal !== undefined && (
                            <div
                              className={
                                row.primary_plan.days_to_renewal < 0
                                  ? 'crm-due-over'
                                  : row.primary_plan.days_to_renewal <= 30
                                    ? 'crm-due-today'
                                    : 'crm-sub'
                              }
                            >
                              {inDays(row.primary_plan.days_to_renewal)}
                            </div>
                          )}
                      </td>
                      <td>{row.manager_name ?? <span className="crm-muted">—</span>}</td>
                      <td>
                        <StateText value={row.status} />
                      </td>
                      <td>
                        <div className="crm-row-actions">
                          <button
                            className="crm-icon-btn"
                            onClick={() => setOpenId(row.id)}
                            title="Open this customer"
                            aria-label={`Open ${row.name}`}
                          >
                            <IconEdit size={15} />
                          </button>
                          <button
                            className="crm-icon-btn crm-icon-danger"
                            onClick={() => remove(row)}
                            title="Delete"
                            aria-label={`Delete ${row.name}`}
                          >
                            <IconTrash size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="crm-foot">
              <span>
                {list.length} of {everyone.length} customer{everyone.length === 1 ? '' : 's'}
              </span>
            </div>
          </>
        )}
      </section>

      {importing && (
        <ImportCustomersDialog
          onClose={() => setImporting(false)}
          onDone={() => { rows.reload(); all.reload() }}
        />
      )}
      {adding && (
        <CustomerForm
          onClose={() => setAdding(false)}
          onSaved={(created) => {
            setAdding(false)
            rows.reload()
            all.reload()
            // Straight into the record, because the next thing anybody does
            // after creating a customer is say what they bought.
            setOpenId(created.id)
          }}
        />
      )}

    </div>
  )
}

/* -------------------------------------------------------------- profile --- */

const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—')
const fmtDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'

function CpCard({ title, icon, badge, action, children }: {
  title: string; icon?: ReactNode; badge?: ReactNode; action?: ReactNode; children: ReactNode
}) {
  return (
    <section className="card ldp-card cp-card">
      <div className="ldp-card-head">
        {icon && <span className="ldp-card-icon" aria-hidden>{icon}</span>}
        <h2 className="ldp-card-title">{title}</h2>
        {badge}
        {action && <div className="ldp-card-action cp-actions">{action}</div>}
      </div>
      {children}
    </section>
  )
}

function CpFact({ icon, label, value, wide, mono }: { icon?: ReactNode; label: string; value: ReactNode; wide?: boolean; mono?: boolean }) {
  return (
    <div className={`ldp-fact${wide ? ' is-wide' : ''}`}>
      <span className="ldp-fact-label">{icon}{label}</span>
      <span className={`ldp-fact-value${mono ? ' cp-mono' : ''}`}>{value === null || value === undefined || value === '' ? '—' : value}</span>
    </div>
  )
}

function CpEmpty({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="cp-empty">
      <span aria-hidden>{icon}</span>
      <b>{title}</b>
      <p>{body}</p>
    </div>
  )
}

/** A customer, opened from My Customers: who they are, what they hold, and
 *  every call, follow-up, visit and quotation — one page, newest first. */
function CustomerProfile({ customerId, onBack, onChanged, onDelete }: {
  customerId: string
  onBack: () => void
  onChanged: () => void
  onDelete: (c: CustomerDetail) => void
}) {
  const navigate = useNavigate()
  const detail = useQuery<CustomerDetail>(`crm-customer-${customerId}`, () => crm.customer(customerId))
  const [planEditing, setPlanEditing] = useState<CustomerPlan | null>(null)
  const [addingPlan, setAddingPlan] = useState(false)
  const [booking, setBooking] = useState(false)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const c = detail.data
  const reload = () => { detail.reload(); onChanged() }

  async function act(fn: () => Promise<unknown>, fail: string) {
    setError(null)
    try {
      await fn()
      reload()
    } catch (err) {
      setError(crmError(err, fail))
    }
  }

  if (!c) {
    return (
      <div className="crm ldp cp">
        <button type="button" className="btn" onClick={onBack}><IconArrowLeft size={15} /> My Customers</button>
        {detail.error ? <ErrorNote>{detail.error}</ErrorNote> : <Loading />}
      </div>
    )
  }

  // An API that predates these lists sends none — show them as empty.
  const followUps = c.follow_ups ?? []
  const quotations = c.quotations ?? []
  const openFollowUps = followUps.filter((f) => f.status === 'pending')
  const place = [c.city_name, c.state_name, c.pincode].filter(Boolean).join(', ')

  return (
    <div className="crm ldp cp">
      <header className="cp-head">
        <button type="button" className="cp-back" onClick={onBack}><IconArrowLeft size={15} /> My Customers</button>
        <span className="cp-sep" aria-hidden />
        <h1 className="cp-name">{c.name}</h1>
        <StateText value={c.status} />
        {c.converted_from_lead_id && (
          <button type="button" className="cp-lead" onClick={() => navigate(`/crm/leads/${c.converted_from_lead_id}`)}>
            <IconReturn size={13} /> Converted from lead
          </button>
        )}
        <span className="cp-gap" />
        <WhatsAppButton mobile={c.whatsapp ?? c.mobile} />
        <button type="button" className="btn" onClick={() => setEditing(true)}><IconEdit size={14} /> Edit</button>
        <button type="button" className="btn btn-primary" onClick={() => setAddingPlan(true)}><IconPlus size={14} /> Add Product / Service</button>
        <button type="button" className="crm-icon-btn crm-icon-danger" title="Delete customer" aria-label={`Delete ${c.name}`} onClick={() => onDelete(c)}>
          <IconTrash size={15} />
        </button>
      </header>
      {error && <div className="cp-error"><ErrorNote>{error}</ErrorNote></div>}

      <div className="cp-stack">
        <CpCard title="Customer details">
          <div className="ldp-facts">
            <CpFact icon={<IconSheet size={14} />} label="Customer ID" value={c.code} mono />
            <CpFact icon={<IconPhone size={14} />} label="Mobile" value={c.mobile} mono />
            <CpFact icon={<IconPhone size={14} />} label="WhatsApp" value={c.whatsapp ?? c.mobile} mono />
            <CpFact icon={<IconMail size={14} />} label="Email" value={c.email} />
            <CpFact icon={<IconBuilding size={14} />} label="Company" value={c.company} />
            <CpFact icon={<IconUser size={14} />} label="Account manager" value={c.manager_name} />
            <CpFact icon={<IconCalendar size={14} />} label={c.converted_from_lead_id ? 'Conversion date' : 'Customer since'} value={fmtDate(c.created_at)} />
            <CpFact icon={<IconPin size={14} />} label="Location" value={place} />
            <CpFact icon={<IconUser size={14} />} label="Customer type" value={c.customer_type} />
            <CpFact icon={<IconBriefcase size={14} />} label="Lead source" value={c.source_name} />
            <CpFact icon={<IconBriefcase size={14} />} label="Industry" value={c.industry_name} />
            <CpFact icon={<IconSheet size={14} />} label="GSTIN" value={c.gstin} mono />
            <CpFact label="Address" value={c.address} wide />
            {c.notes && <CpFact label="Notes" value={c.notes} wide />}
          </div>
        </CpCard>

        <CpCard title="Products & services" badge={<span className="cp-count">{c.plans.length ? c.plans.length : 'none yet'}</span>}
          action={<button type="button" className="btn btn-primary btn-sm" onClick={() => setAddingPlan(true)}><IconPlus size={14} /> Add Product / Service</button>}>
          {c.plans.length === 0 ? (
            <CpEmpty icon={<IconBriefcase size={22} />} title="Nothing assigned yet"
              body="Assign a product or service from your master to start the plan and renewal clock." />
          ) : (
            <div className="table-wrap"><table className="cp-table">
              <thead><tr><th>Product / service</th><th>Plan</th><th>Period</th><th>Renewal</th><th className="crm-num">Amount</th><th>Payment</th><th className="cp-c-act" /></tr></thead>
              <tbody>{c.plans.map((plan) => (
                <tr key={plan.id}>
                  <td className="crm-strong">{plan.product_name}</td>
                  <td>{plan.plan_name ?? <span className="crm-muted">—</span>}</td>
                  <td className="crm-sub">{fmtDate(plan.start_on)} → {plan.end_on ? fmtDate(plan.end_on) : 'Perpetual'}</td>
                  <td className={plan.days_to_renewal !== null && plan.days_to_renewal < 0 ? 'crm-due-over' : plan.days_to_renewal !== null && plan.days_to_renewal <= 30 ? 'crm-due-today' : ''}>
                    {plan.end_on ? inDays(plan.days_to_renewal) : '—'}
                  </td>
                  <td className="crm-num">{rupees(plan.amount)}</td>
                  <td><StateText value={plan.payment_status} /></td>
                  <td className="cp-c-act">
                    <div className="crm-row-actions">
                      <button type="button" className="crm-icon-btn" title="Edit" aria-label="Edit plan" onClick={() => setPlanEditing(plan)}><IconEdit size={14} /></button>
                      <button type="button" className="crm-icon-btn crm-icon-danger" title="Remove" aria-label="Remove plan"
                        onClick={() => { if (window.confirm(`Remove ${plan.product_name} from ${c.name}?`)) void act(() => crm.deletePlan(plan.id), 'That plan could not be removed') }}>
                        <IconTrash size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </CpCard>

        <CpCard title="Support History" badge={<span className="cp-count">{c.interactions.length}</span>}
          action={<button type="button" className="btn btn-sm" onClick={() => navigate('/crm/support')}><IconUsers size={14} /> Support desk</button>}>
          {c.interactions.length === 0 ? (
            <CpEmpty icon={<IconPhone size={22} />} title="No calls logged yet" body="Calls logged on the Support desk for this customer appear here." />
          ) : (
            <div className="table-wrap"><table className="cp-table">
              <thead><tr><th>Logged</th><th>Ticket</th><th>Direction</th><th>Disposition</th><th>Remarks</th><th>Status</th><th>Handled by</th><th>Follow-up</th></tr></thead>
              <tbody>{c.interactions.map((i) => (
                <tr key={i.id}>
                  <td className="cp-nowrap">{fmtDateTime(i.created_at)}</td>
                  <td className="cp-mono crm-strong">{i.ticket_no}</td>
                  <td><span className={`cp-pill is-${i.direction}`}>{i.direction === 'inbound' ? 'Inbound' : 'Outbound'}</span></td>
                  <td>{i.disposition_name ? <span className="cp-pill is-disp">{i.disposition_name}</span> : <span className="crm-muted">—</span>}</td>
                  <td className="cp-remarks">{i.remarks || <span className="crm-muted">—</span>}</td>
                  <td><span className={`cp-pill is-${i.status}`}>{i.status === 'open' ? 'Open' : 'Closed'}</span></td>
                  <td>{i.staff_name ?? <span className="crm-muted">—</span>}</td>
                  <td className="cp-nowrap">{i.follow_up_due_at ? fmtDateTime(i.follow_up_due_at) : <span className="crm-muted">—</span>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </CpCard>

        <CpCard title="Follow-up History" badge={openFollowUps.length > 0 ? <span className="cp-count is-warn">{openFollowUps.length} open</span> : undefined}
          action={<>
            <button type="button" className="btn btn-sm" onClick={() => navigate('/crm/follow-ups')}><IconCalendar size={14} /> All follow-ups</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setBooking(true)}><IconPlus size={14} /> Add</button>
          </>}>
          {followUps.length === 0 ? (
            <CpEmpty icon={<IconCalendar size={22} />} title="No follow-ups yet" body="Book one with Add — it lands on the owner's follow-up list." />
          ) : (
            <ul className="cp-fu">
              {followUps.map((f) => (
                <li key={f.id} className={`is-${f.status}`}>
                  <div className="cp-fu-main">
                    <div className="cp-fu-top">
                      <b className={f.is_overdue && f.status === 'pending' ? 'cp-over' : ''}>
                        {f.is_overdue && f.status === 'pending' ? 'Overdue · ' : ''}{fmtDateTime(f.due_at)}
                      </b>
                      <span className={`cp-pill is-fu-${f.status}`}>{f.status === 'pending' ? 'Pending' : f.status === 'done' ? 'Done' : 'Cancelled'}</span>
                    </div>
                    {f.purpose && <span className="cp-fu-purpose">{f.purpose}</span>}
                    {(f.outcome || f.notes) && <span className="cp-fu-notes">{f.outcome ?? f.notes}</span>}
                    <small>{f.owner_name ?? 'Unassigned'}{f.completed_at ? ` · done ${fmtDateTime(f.completed_at)}` : ''}</small>
                  </div>
                  <div className="crm-row-actions">
                    {f.status === 'pending' && (
                      <button type="button" className="crm-icon-btn cp-ok" title="Mark done" aria-label="Mark follow-up done"
                        onClick={() => void act(() => crm.completeFollowUp(f.id, {}), 'That follow-up could not be closed')}><IconCheck size={14} /></button>
                    )}
                    <button type="button" className="crm-icon-btn crm-icon-danger" title="Delete" aria-label="Delete follow-up"
                      onClick={() => { if (window.confirm('Delete this follow-up?')) void act(() => crm.deleteFollowUp(f.id), 'That follow-up could not be deleted') }}>
                      <IconTrash size={14} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CpCard>

        <CpCard title="Visit History" badge={c.visits.length ? <span className="cp-count">{c.visits.length}</span> : undefined}
          action={<button type="button" className="btn btn-sm" onClick={() => navigate('/crm/visits')}><IconPin size={14} /> All visits</button>}>
          {c.visits.length === 0 ? (
            <CpEmpty icon={<IconPin size={22} />} title="No visits recorded yet" body="Book one from My Visits and it appears here with its start and end confirmation." />
          ) : (
            <div className="table-wrap"><table className="cp-table">
              <thead><tr><th>Visit</th><th>Scheduled</th><th>Type</th><th>Purpose</th><th>Assigned to</th><th>Status</th><th>Outcome</th></tr></thead>
              <tbody>{c.visits.map((v) => (
                <tr key={v.id}>
                  <td className="cp-mono crm-strong">{v.visit_no}</td>
                  <td className="cp-nowrap">{fmtDateTime(v.scheduled_at)}</td>
                  <td>{v.visit_type_name ?? <span className="crm-muted">—</span>}</td>
                  <td className="cp-remarks">{v.purpose ?? <span className="crm-muted">—</span>}</td>
                  <td>{v.employee_name ?? <span className="crm-muted">—</span>}</td>
                  <td><StateText value={v.status} /></td>
                  <td className="cp-remarks">{v.outcome ?? <span className="crm-muted">—</span>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </CpCard>

        <CpCard title="Quotations" icon={<IconSheet size={16} />} badge={quotations.length ? <span className="cp-count">{quotations.length}</span> : undefined}
          action={<button type="button" className="btn btn-primary btn-sm" onClick={() => navigate(`/crm/quotations/new?customer=${c.id}`)}><IconPlus size={14} /> New quotation</button>}>
          {quotations.length === 0 ? (
            <CpEmpty icon={<IconSheet size={22} />} title="No quotations yet" body="Raise one with New quotation — the customer's details come across on their own." />
          ) : (
            <div className="table-wrap"><table className="cp-table">
              <thead><tr><th>Quotation</th><th>Date</th><th>Valid until</th><th className="crm-num">Amount</th><th>Status</th><th>Prepared by</th></tr></thead>
              <tbody>{quotations.map((q) => (
                <tr key={q.id} className="cp-link-row" onClick={() => navigate(`/crm/quotations/${q.id}`)}>
                  <td className="cp-mono crm-strong">{q.number ?? 'Draft'}</td>
                  <td>{fmtDate(q.quote_date)}</td>
                  <td>{fmtDate(q.valid_until)}</td>
                  <td className="crm-num crm-strong">{rupees(q.grand_total)}</td>
                  <td><StateText value={q.status} /></td>
                  <td>{q.created_by_name ?? <span className="crm-muted">—</span>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </CpCard>
      </div>

      {(addingPlan || planEditing) && (
        <PlanForm customerId={c.id} plan={planEditing}
          onClose={() => { setAddingPlan(false); setPlanEditing(null) }}
          onSaved={() => { setAddingPlan(false); setPlanEditing(null); reload() }} />
      )}
      {editing && (
        <CustomerForm customer={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload() }} />
      )}
      {booking && <BookFollowUp customerId={c.id} onClose={() => setBooking(false)} onSaved={() => { setBooking(false); reload() }} />}
    </div>
  )
}

/** Book a follow-up against the customer — the same booking a lead page makes. */
function BookFollowUp({ customerId, onClose, onSaved }: { customerId: string; onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(todayISO())
  const [time, setTime] = useState('10:00')
  const [purpose, setPurpose] = useState('')
  const [notes, setNotes] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function save() {
    setBusy(true)
    setError(null)
    try {
      await crm.createFollowUp({
        customer_id: customerId, due_at: localToISO(`${date}T${time || '10:00'}`),
        purpose: purpose.trim() || null, notes: notes.trim() || null, owner_id: ownerId || null,
      })
      onSaved()
    } catch (err) {
      setError(crmError(err, 'That follow-up could not be booked'))
      setBusy(false)
    }
  }
  return (
    <Dialog title="Add follow-up" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !date} onClick={() => void save()}>{busy ? 'Booking…' : 'Book follow-up'}</button>
      </>
    }>
      <div className="ldp-form">
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="ldp-two">
          <label className="ldp-field"><span>Date</span><input type="date" value={date} min={todayISO()} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="ldp-field"><span>Time</span><input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
        </div>
        <label className="ldp-field"><span>Purpose</span>
          <input value={purpose} maxLength={300} onChange={(e) => setPurpose(e.target.value)} placeholder="Renewal call, update call, payment reminder…" /></label>
        <label className="ldp-field"><span>Remarks</span>
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What's the plan for this follow-up?" /></label>
        <label className="ldp-field"><span>Assign to</span>
          <OwnerSelect value={ownerId} onChange={setOwnerId} placeholder="Whoever manages the customer" /></label>
      </div>
    </Dialog>
  )
}

/* ------------------------------------------------------------------- form --- */

function CustomerForm({
  customer,
  onClose,
  onSaved,
  extras,
  page,
}: {
  customer?: Customer
  onClose: () => void
  onSaved: (row: Customer) => void
  /** Shown beside the fields when editing: the customer's plans and calls. */
  extras?: ReactNode
  /** Editing opens as a full page rather than a dialog. */
  page?: boolean
}) {
  const [code, setCode] = useState(customer?.code ?? '')
  const [name, setName] = useState(customer?.name ?? '')
  const [company, setCompany] = useState(customer?.company ?? '')
  const [mobile, setMobile] = useState(customer?.mobile ?? '')
  const [sameNumber, setSameNumber] = useState(
    customer ? (customer.whatsapp ?? customer.mobile) === customer.mobile : true,
  )
  const [whatsapp, setWhatsapp] = useState(customer?.whatsapp ?? '')
  const [email, setEmail] = useState(customer?.email ?? '')
  const [type, setType] = useState(customer?.customer_type ?? '')
  const [industryId, setIndustryId] = useState(customer?.industry_id ?? '')
  const [sourceId, setSourceId] = useState(customer?.source_id ?? '')
  const [gstin, setGstin] = useState(customer?.gstin ?? '')
  const [countryId, setCountryId] = useState(customer?.country_id ?? '')
  const [stateId, setStateId] = useState(customer?.state_id ?? '')
  const [cityId, setCityId] = useState(customer?.city_id ?? '')
  const [pincode, setPincode] = useState(customer?.pincode ?? '')
  const [address, setAddress] = useState(customer?.address ?? '')
  const [managerId, setManagerId] = useState(customer?.manager_id ?? '')
  const [status, setStatus] = useState(customer?.status ?? 'active')
  const [notes, setNotes] = useState(customer?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const countries = useQuery('crm-countries', () => crm.masters('countries'))
  useEffect(() => {
    if (!countryId && countries.data?.length) setCountryId(countries.data[0].id)
  }, [countries.data, countryId])

  async function save() {
    setBusy(true)
    setError(null)
    const body = {
      code: code || null,
      name,
      company: company || null,
      mobile,
      whatsapp: sameNumber ? mobile : whatsapp || null,
      email: email || null,
      customer_type: type || null,
      industry_id: industryId || null,
      source_id: sourceId || null,
      gstin: gstin || null,
      country_id: countryId || null,
      state_id: stateId || null,
      city_id: cityId || null,
      pincode: pincode || null,
      address: address || null,
      manager_id: managerId || null,
      status,
      notes: notes.trim() || null,
    }
    try {
      const saved = customer
        ? await crm.patchCustomer(customer.id, body)
        : await crm.createCustomer(body)
      onSaved(saved)
    } catch (err) {
      setError(crmError(err, 'That customer could not be saved'))
      setBusy(false)
    }
  }

  // Checked as the person types, shown once they have left the field.
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const touch = (key: string) => () => setTouched((t) => ({ ...t, [key]: true }))
  const digits = (s: string) => s.replace(/\D/g, '')
  const phoneBad = (s: string) => s.trim() !== '' && (digits(s).length < 10 || digits(s).length > 15)
  const mobileBad = phoneBad(mobile)
  const whatsappBad = !sameNumber && phoneBad(whatsapp)
  const emailBad = email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  const gstinBad = gstin.trim() !== '' && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(gstin.trim())
  const pincodeBad = pincode.trim() !== '' && !/^\d{6}$/.test(pincode.trim())
  const ready = name.trim() !== '' && mobile.trim() !== ''
    && !mobileBad && !whatsappBad && !emailBad && !gstinBad && !pincodeBad

  const form = (
      <form className="lf" id="crm-customer-form" noValidate
            onSubmit={(event) => { event.preventDefault(); if (ready && !busy) save() }}>
        {error && <ErrorNote>{error}</ErrorNote>}
        <LfSection icon={<IconBuilding size={16} />} title="Customer" note="Who the account is, and where it stands.">
          <LfField label="Customer name" required>
            <LfInput icon={<IconUser size={15} />}>
              <input value={name} onChange={(event) => setName(event.target.value)}
                     placeholder="e.g. Rahul Sharma" autoFocus required />
            </LfInput>
          </LfField>
          <LfField label="Company name">
            <LfInput icon={<IconBriefcase size={15} />}>
              <input value={company} onChange={(event) => setCompany(event.target.value)} placeholder="Company / firm name" />
            </LfInput>
          </LfField>
          <LfField label="Customer ID"
                   hint={customer ? 'Fixed once the customer is created.' : 'Your own reference — generated when left blank.'}>
            <LfInput prefix="#">
              <input value={code} onChange={(event) => setCode(event.target.value)} disabled={Boolean(customer)}
                     placeholder="Auto-generated" />
            </LfInput>
          </LfField>
          <LfField label="Customer type">
            <select value={type} onChange={(event) => setType(event.target.value)}>
              <option value="">Select type</option>
              {CUSTOMER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              {type && !CUSTOMER_TYPES.includes(type) && <option value={type}>{type}</option>}
            </select>
          </LfField>
          <LfField label="Status" wide>
            <div className="lf-pills" role="radiogroup" aria-label="Status">
              {CUSTOMER_STATUSES.map((s) => (
                <button key={s.key} type="button" role="radio" aria-checked={status === s.key}
                        className={`lf-pill tone-${s.tone}${status === s.key ? ' is-on' : ''}`}
                        onClick={() => setStatus(s.key)}>
                  <i aria-hidden /> {s.label}
                </button>
              ))}
            </div>
          </LfField>
        </LfSection>

        <LfSection icon={<IconPhone size={16} />} title="Contact" note="How the desk and the account manager reach them.">
          <LfField label="Mobile number" required
                   error={touched.mobile && mobileBad ? 'Enter a 10-digit mobile number.' : undefined}>
            <LfInput icon={<IconPhone size={15} />} bad={touched.mobile && mobileBad}>
              <input value={mobile} onChange={(event) => setMobile(event.target.value)} onBlur={touch('mobile')}
                     placeholder="98765 43210" inputMode="tel" required />
            </LfInput>
          </LfField>
          <LfField label="Email" error={touched.email && emailBad ? 'That does not look like an email address.' : undefined}>
            <LfInput icon={<IconMail size={15} />} bad={touched.email && emailBad}>
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} onBlur={touch('email')}
                     placeholder="name@company.com" />
            </LfInput>
          </LfField>
          <LfField label="WhatsApp number" wide
                   error={touched.whatsapp && whatsappBad ? 'Enter a 10-digit WhatsApp number.' : undefined}
                   aside={
                     <label className="lf-switch">
                       <input type="checkbox" checked={sameNumber} onChange={(event) => setSameNumber(event.target.checked)} />
                       <span className="lf-switch-track" aria-hidden><span /></span>
                       Same as mobile
                     </label>
                   }>
            <LfInput icon={<IconPhone size={15} />} bad={touched.whatsapp && whatsappBad}>
              <input value={sameNumber ? mobile : whatsapp} onChange={(event) => setWhatsapp(event.target.value)}
                     onBlur={touch('whatsapp')} disabled={sameNumber} inputMode="tel"
                     placeholder={sameNumber ? 'Uses the mobile number' : 'WhatsApp number'} />
            </LfInput>
          </LfField>
        </LfSection>

        <LfSection icon={<IconSheet size={16} />} title="Business & tax" note="Classification, ownership and GST for their quotations.">
          <LfField label="Industry">
            <MasterSelect kind="industries" value={industryId} onChange={setIndustryId} placeholder="Select industry" />
          </LfField>
          <LfField label="Lead source">
            <MasterSelect kind="sources" value={sourceId} onChange={setSourceId} placeholder="Select source" />
          </LfField>
          <LfField label="Account manager" hint="Left empty, the account is yours.">
            <OwnerSelect value={managerId} onChange={setManagerId} placeholder="You" />
          </LfField>
          <LfField label="GSTIN"
                   error={touched.gstin && gstinBad ? 'A GSTIN is 15 characters, like 27AAAAA0000A1Z5.' : undefined}
                   hint="Decides the tax treatment on their quotations.">
            <LfInput icon={<IconCard size={15} />} bad={touched.gstin && gstinBad}>
              <input value={gstin} onChange={(event) => setGstin(event.target.value.toUpperCase())} onBlur={touch('gstin')}
                     placeholder="27AAAAA0000A1Z5" maxLength={15} className="lf-mono" />
            </LfInput>
          </LfField>
        </LfSection>

        <LfSection icon={<IconPin size={16} />} title="Address" note="Billing address, and where visits are planned.">
          <LfField label="Country">
            <MasterSelect
              kind="countries"
              value={countryId}
              onChange={(next) => {
                setCountryId(next)
                setStateId('')
                setCityId('')
              }}
              placeholder="Select country"
            />
          </LfField>
          <LfField label="State">
            <MasterSelect
              kind="states"
              value={stateId}
              onChange={(next) => {
                setStateId(next)
                setCityId('')
              }}
              parentId={countryId}
              placeholder="Select state"
            />
          </LfField>
          <LfField label="City" hint={stateId ? undefined : 'Pick a state first.'}>
            <MasterSelect kind="cities" value={cityId} onChange={setCityId} parentId={stateId} placeholder="Select city" />
          </LfField>
          <LfField label="Pincode" error={touched.pincode && pincodeBad ? 'A pincode is 6 digits.' : undefined}>
            <LfInput icon={<IconPin size={15} />} bad={touched.pincode && pincodeBad}>
              <input value={pincode} onChange={(event) => setPincode(event.target.value)} onBlur={touch('pincode')}
                     placeholder="6-digit pincode" inputMode="numeric" maxLength={6} />
            </LfInput>
          </LfField>
          <LfField label="Address" wide>
            <textarea value={address} onChange={(event) => setAddress(event.target.value)} rows={2}
                      placeholder="Building, street, area, landmark" />
          </LfField>
        </LfSection>

        <LfSection icon={<IconSheet size={16} />} title="Notes" note="Anything the team should know about this account.">
          {customer && (
            <LfField label={customer.converted_from_lead_id ? 'Conversion date' : 'Customer since'}>
              <input value={new Date(customer.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                     readOnly disabled className="lf-readonly" />
            </LfField>
          )}
          <LfField label="Notes" wide>
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} maxLength={4000}
                      placeholder="Preferences, history, special terms…" />
          </LfField>
        </LfSection>
        {extras && !page && <div className="lf-extras">{extras}</div>}
      </form>
  )

  if (page && customer) {
    const plan = customer.primary_plan
    return (
      <div className="cup">
        <header className="cup-head">
          <button type="button" className="btn cup-back" onClick={onClose}>
            <IconArrowLeft size={15} /> All customers
          </button>
          <div className="cup-id">
            <Avatar name={name || customer.name} />
            <div>
              <h1>{name || customer.name}</h1>
              <p>
                <span className="crm-code">{customer.code}</span>
                {company && <> · {company}</>}
                {mobile && <> · {mobile}</>}
              </p>
            </div>
            <StateText value={status} />
          </div>
        </header>

        <div className="cup-body">
          <div className="cup-main">{form}</div>
          <aside className="cup-side">
            <section className="cup-card cup-facts">
              <h3>Account summary</h3>
              <dl>
                <div><dt>Customer since</dt><dd>{customer.created_at.slice(0, 10)}</dd></div>
                <div><dt>Account manager</dt><dd>{customer.manager_name ?? 'Unassigned'}</dd></div>
                <div><dt>Current plan</dt><dd>{plan?.product_name ?? 'None yet'}</dd></div>
                <div>
                  <dt>Next renewal</dt>
                  <dd className={plan?.days_to_renewal !== null && plan?.days_to_renewal !== undefined && plan.days_to_renewal < 0 ? 'crm-due-over' : ''}>
                    {plan?.renewal_on ? <>{plan.renewal_on} <small>({inDays(plan.days_to_renewal)})</small></> : '—'}
                  </dd>
                </div>
              </dl>
            </section>
            {extras}
          </aside>
        </div>

        <footer className="cup-foot">
          <span className="lf-foot-note"><span className="lf-req">*</span> Required fields</span>
          {error && <span className="error">{error}</span>}
          <span className="crm-push" />
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary lf-save" type="submit" form="crm-customer-form" disabled={busy || !ready}>
            <IconCheck size={15} /> {busy ? 'Saving…' : 'Save changes'}
          </button>
        </footer>
      </div>
    )
  }

  return (
    <Dialog
      title={customer ? `Edit ${customer.name}` : 'Add new customer'}
      subtitle={customer
        ? <><span className="crm-code">{customer.code}</span> · {customer.mobile}</>
        : 'Products and services are added next, once the customer is saved.'}
      onClose={onClose}
      footer={
        <>
          <span className="lf-foot-note"><span className="lf-req">*</span> Required fields</span>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary lf-save" type="submit" form="crm-customer-form" disabled={busy || !ready}>
            <IconCheck size={15} /> {busy ? 'Saving…' : customer ? 'Save changes' : 'Save customer'}
          </button>
        </>
      }
    >
      {form}
    </Dialog>
  )
}

const CUSTOMER_TYPES = ['Enterprise', 'SMB', 'Individual', 'Reseller']

const CUSTOMER_STATUSES: Array<{ key: Customer['status']; label: string; tone: string }> = [
  { key: 'active', label: 'Active', tone: 'good' },
  { key: 'on_hold', label: 'On hold', tone: 'warn' },
  { key: 'expired', label: 'Expired', tone: 'idle' },
  { key: 'churned', label: 'Churned', tone: 'bad' },
]

/* ----------------------------------------------------------------- editor --- */

/** One customer, on one full page: the Edit customer form, and beside it what
 *  they bought and the latest calls. The row's edit icon, its name, a new
 *  customer and a renewal link all open this; there is no separate panel. */
function PlanForm({
  customerId,
  plan,
  onClose,
  onSaved,
}: {
  customerId: string
  plan: CustomerPlan | null
  onClose: () => void
  onSaved: () => void
}) {
  const [productId, setProductId] = useState(plan?.product_id ?? '')
  const [planId, setPlanId] = useState(plan?.plan_id ?? '')
  const [productName, setProductName] = useState(plan?.product_name ?? '')
  const [startOn, setStartOn] = useState(plan?.start_on ?? todayISO())
  const [endOn, setEndOn] = useState(plan?.end_on ?? '')
  const [renewalOn, setRenewalOn] = useState(plan?.renewal_on ?? '')
  const [amount, setAmount] = useState(plan?.amount ?? '')
  const [payment, setPayment] = useState(plan?.payment_status ?? 'pending')
  const [status, setStatus] = useState(plan?.status ?? 'active')
  const [notes, setNotes] = useState(plan?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setError(null)
    const body = {
      product_id: productId || null,
      plan_id: planId || null,
      // Free text is allowed so a sale can be recorded for something the
      // catalogue has not caught up with — the sale happened either way.
      product_name: productName || null,
      start_on: startOn,
      end_on: endOn || null,
      renewal_on: renewalOn || null,
      amount: amount || '0',
      payment_status: payment,
      status,
      notes: notes || null,
    }
    try {
      if (plan) await crm.updatePlan(plan.id, body)
      else await crm.addPlan(customerId, body)
      onSaved()
    } catch (err) {
      setError(crmError(err, 'That plan could not be saved'))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={plan ? 'Edit plan' : 'Add a plan'}
      subtitle="Leave the end date blank and it is worked out from the plan's own duration."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save plan'}
          </button>
        </>
      }
    >
      <div className="crm-form">
        {error && (
          <div className="crm-form-wide">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}
        <Field label="Product / Service">
          <MasterSelect
            kind="products"
            value={productId}
            onChange={(next) => {
              setProductId(next)
              setPlanId('')
            }}
          />
        </Field>
        <Field label="Plan">
          <MasterSelect kind="plans" value={planId} onChange={setPlanId} parentId={productId} />
        </Field>

        <Field
          label="Or type what they bought"
          wide
          hint="Used when it is not on the catalogue yet."
        >
          <input
            value={productName}
            onChange={(event) => setProductName(event.target.value)}
            placeholder="Product name as it should read"
          />
        </Field>

        <Field label="Starts on">
          <input type="date" value={startOn} onChange={(event) => setStartOn(event.target.value)} />
        </Field>
        <Field label="Ends on">
          <input type="date" value={endOn} onChange={(event) => setEndOn(event.target.value)} />
        </Field>

        <Field label="Renewal date" hint="Defaults to the end date.">
          <input type="date" value={renewalOn} onChange={(event) => setRenewalOn(event.target.value)} />
        </Field>
        <Field label="Amount">
          <input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            placeholder="0.00"
          />
        </Field>

        <Field label="Payment">
          <select value={payment} onChange={(event) => setPayment(event.target.value as typeof payment)}>
            <option value="pending">Pending</option>
            <option value="partial">Partial</option>
            <option value="paid">Paid</option>
          </select>
        </Field>
        <Field label="Status">
          <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
            <option value="active">Active</option>
            <option value="expired">Expired</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </Field>

        <Field label="Notes" wide>
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} />
        </Field>
      </div>
    </Dialog>
  )
}

/* ------------------------------------------------------------- import --- */

/** One quoted-CSV line into cells. */
function csvCells(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out.map((c) => c.trim())
}

const IMPORT_COLUMNS = ['name', 'mobile', 'company', 'email', 'whatsapp', 'customer_type', 'gstin', 'pincode', 'address'] as const

/** Customers from a CSV, one create per row. There is no bulk endpoint for
 *  customers, so each row goes through the same create the form uses — with
 *  the same validation — and the result says which rows did not make it. */
function ImportCustomersDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<Array<Record<string, string>>>([])
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: number; failed: Array<{ row: number; reason: string }> } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function read(file: File) {
    setError(null)
    setResult(null)
    setFileName(file.name)
    const text = await file.text()
    const lines = text.split(/\r?\n/).filter((l) => l.trim())
    if (lines.length < 2) { setRows([]); setError('The file has no rows under its header.'); return }
    const head = csvCells(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, ''))
    if (!head.includes('name') || !head.includes('mobile')) {
      setRows([])
      setError('The first line must be a header with at least "name" and "mobile" columns.')
      return
    }
    setRows(lines.slice(1).map((line) => {
      const cells = csvCells(line)
      return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? '']))
    }))
  }

  async function run() {
    setBusy(true)
    const failed: Array<{ row: number; reason: string }> = []
    let ok = 0
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      const body: Record<string, string | null> = {}
      for (const key of IMPORT_COLUMNS) body[key] = r[key]?.trim() || null
      try {
        await crm.createCustomer(body)
        ok++
      } catch (err) {
        failed.push({ row: i + 2, reason: crmError(err, 'Rejected') })
      }
    }
    setBusy(false)
    setResult({ ok, failed })
    if (ok) onDone()
  }

  return (
    <Dialog
      title="Import customers"
      subtitle="A CSV with a header row. name and mobile are required; company, email, whatsapp, customer_type, gstin, pincode and address are read when present."
      onClose={onClose}
      footer={
        result ? (
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        ) : (
          <>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void run()} disabled={busy || rows.length === 0}>
              {busy ? 'Importing…' : `Import ${rows.length || ''} customer${rows.length === 1 ? '' : 's'}`}
            </button>
          </>
        )
      }
    >
      <div className="crm-form">
        {error && <div className="crm-form-wide"><ErrorNote>{error}</ErrorNote></div>}
        <Field label="File" wide>
          <input type="file" accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void read(f) }} />
        </Field>
        {fileName && !result && rows.length > 0 && (
          <p className="crm-form-wide crm-sub">{rows.length} row{rows.length === 1 ? '' : 's'} read from {fileName}.</p>
        )}
        {result && (
          <div className="crm-form-wide">
            <p><strong>{result.ok}</strong> customer{result.ok === 1 ? '' : 's'} added.</p>
            {result.failed.length > 0 && (
              <>
                <p className="crm-sub">{result.failed.length} row{result.failed.length === 1 ? '' : 's'} skipped:</p>
                <ul className="cu-import-fails">
                  {result.failed.slice(0, 20).map((f) => <li key={f.row}>Line {f.row}: {f.reason}</li>)}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </Dialog>
  )
}
