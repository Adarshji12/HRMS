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
import { useSearchParams } from 'react-router-dom'
import '../../styles/crm.css'
import '../../styles/hrdash.css'
import '../../styles/leads.css'
import { useQuery } from '../../lib/useQuery'
import { dateTime } from '../../lib/format'
import { Avatar, EmptyState, ErrorNote, Loading } from '../../components/ui'
import {
  IconAlert,
  IconCalendar,
  IconCheck,
  IconClock,
  IconClose,
  IconDownload,
  IconEdit,
  IconFilter,
  IconPlus,
  IconReturn,
  IconSearch,
  IconTrash,
  IconUpload,
  IconUsers,
} from '../../components/Icons'
import {
  crm,
  crmError,
  inDays,
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
                            title="Edit this customer"
                            aria-label={`Edit ${row.name}`}
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

      {openId && (
        <CustomerEditor
          key={openId}
          customerId={openId}
          onClose={() => {
            setOpenId(null)
            if (params.get('open')) setParams({}, { replace: true })
          }}
          onChanged={() => {
            rows.reload()
            all.reload()
          }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------- form --- */

function CustomerForm({
  customer,
  onClose,
  onSaved,
  extras,
}: {
  customer?: Customer
  onClose: () => void
  onSaved: (row: Customer) => void
  /** Shown under the fields when editing: the customer's plans and calls. */
  extras?: ReactNode
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

  return (
    <Dialog
      title={customer ? `Edit ${customer.name}` : 'Add Customer'}
      subtitle={customer
        ? `${customer.code} · ${customer.mobile}`
        : 'Products and services are added next, once the customer is saved.'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={busy || !name.trim() || !mobile.trim()}
          >
            {busy ? 'Saving…' : 'Save Customer'}
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
        <Field label="Customer ID" hint="Your own reference — generated when left blank.">
          <input value={code} onChange={(event) => setCode(event.target.value)} disabled={Boolean(customer)} />
        </Field>
        <Field label="Customer name *">
          <input value={name} onChange={(event) => setName(event.target.value)} autoFocus required />
        </Field>

        <Field label="Company name">
          <input value={company} onChange={(event) => setCompany(event.target.value)} />
        </Field>
        <Field label="Mobile number *">
          <input value={mobile} onChange={(event) => setMobile(event.target.value)} required />
        </Field>

        <div className="crm-field">
          <span className="crm-field-label">WhatsApp number</span>
          <input
            value={sameNumber ? '' : whatsapp}
            onChange={(event) => setWhatsapp(event.target.value)}
            placeholder="Same as mobile"
            disabled={sameNumber}
          />
          <label className="crm-check">
            <input
              type="checkbox"
              checked={sameNumber}
              onChange={(event) => setSameNumber(event.target.checked)}
            />
            Same number for WhatsApp
          </label>
        </div>
        <Field label="Email">
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </Field>

        <Field label="Customer type">
          <input
            value={type}
            onChange={(event) => setType(event.target.value)}
            placeholder="Not set"
            list="crm-customer-types"
          />
          <datalist id="crm-customer-types">
            <option value="Enterprise" />
            <option value="SMB" />
            <option value="Individual" />
            <option value="Reseller" />
          </datalist>
        </Field>
        <Field label="Industry">
          <MasterSelect kind="industries" value={industryId} onChange={setIndustryId} placeholder="Not set" />
        </Field>

        <Field label="Lead source">
          <MasterSelect kind="sources" value={sourceId} onChange={setSourceId} placeholder="Not set" />
        </Field>
        <Field label="GSTIN" hint="Decides the tax treatment on their quotations.">
          <input
            value={gstin}
            onChange={(event) => setGstin(event.target.value.toUpperCase())}
            placeholder="27AAAAA0000A1Z5"
          />
        </Field>

        <Field label="Country">
          <MasterSelect
            kind="countries"
            value={countryId}
            onChange={(next) => {
              setCountryId(next)
              setStateId('')
              setCityId('')
            }}
          />
        </Field>
        <Field label="State">
          <MasterSelect
            kind="states"
            value={stateId}
            onChange={(next) => {
              setStateId(next)
              setCityId('')
            }}
            parentId={countryId}
            placeholder="Not set"
          />
        </Field>

        <Field label="City">
          <MasterSelect kind="cities" value={cityId} onChange={setCityId} parentId={stateId} placeholder="Not set" />
        </Field>
        <Field label="Pincode">
          <input value={pincode} onChange={(event) => setPincode(event.target.value)} />
        </Field>

        <Field label="Account manager">
          <OwnerSelect value={managerId} onChange={setManagerId} placeholder="You" />
        </Field>
        <Field label="Status">
          <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
            <option value="active">Active</option>
            <option value="on_hold">On hold</option>
            <option value="expired">Expired</option>
            <option value="churned">Churned</option>
          </select>
        </Field>

        <Field label="Address" wide>
          <textarea value={address} onChange={(event) => setAddress(event.target.value)} rows={3} />
        </Field>

        {extras && <div className="crm-form-wide">{extras}</div>}
      </div>
    </Dialog>
  )
}

/* ----------------------------------------------------------------- editor --- */

/** One customer, in one dialog: the Edit customer form, and under it what they
 *  bought and the latest calls. The row's edit icon, its name, a new customer
 *  and a renewal link all open this; there is no separate record panel. */
function CustomerEditor({
  customerId,
  onClose,
  onChanged,
}: {
  customerId: string
  onClose: () => void
  onChanged: () => void
}) {
  const detail = useQuery<CustomerDetail>(`crm-customer-${customerId}`, () =>
    crm.customer(customerId),
  )
  const customer = detail.data

  if (!customer) {
    return (
      <Dialog title="Customer" onClose={onClose}>
        <div className="crm-form">
          <div className="crm-form-wide">
            {detail.error ? <ErrorNote>{detail.error}</ErrorNote> : <Loading />}
          </div>
        </div>
      </Dialog>
    )
  }

  return (
    <CustomerForm
      customer={customer}
      onClose={onClose}
      onSaved={() => {
        onChanged()
        onClose()
      }}
      extras={
        <CustomerRecord
          customer={customer}
          onChanged={() => {
            detail.reload()
            onChanged()
          }}
        />
      }
    />
  )
}

/** The part of a customer that is not a field: their plans and recent calls. */
function CustomerRecord({
  customer,
  onChanged,
}: {
  customer: CustomerDetail
  onChanged: () => void
}) {
  const [planEditing, setPlanEditing] = useState<CustomerPlan | null>(null)
  const [addingPlan, setAddingPlan] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function removePlan(plan: CustomerPlan) {
    setError(null)
    try {
      await crm.deletePlan(plan.id)
      onChanged()
    } catch (err) {
      setError(crmError(err, 'That plan could not be removed'))
    }
  }

  return (
    <div className="cu-record">
      {error && <ErrorNote>{error}</ErrorNote>}

      {customer.converted_from_lead_id && (
        <div className="notice notice-ok">This account started as a lead.</div>
      )}

      <div>
        <div className="cu-record-head">
          <span className="crm-field-label">Products &amp; plans</span>
          <button type="button" className="btn btn-sm" onClick={() => setAddingPlan(true)}>
            <IconPlus size={14} /> Add a plan
          </button>
        </div>
        {customer.plans.length === 0 ? (
          <p className="empty">Nothing recorded. Add what they bought so renewals can be tracked.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Period</th>
                  <th className="crm-num">Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {customer.plans.map((plan) => (
                  <tr key={plan.id}>
                    <td>
                      <div className="crm-strong">{plan.product_name}</div>
                      <div className="crm-sub">{plan.plan_name ?? '—'}</div>
                    </td>
                    <td className="crm-sub">
                      {plan.start_on} → {plan.end_on ?? 'perpetual'}
                      <div className={plan.days_to_renewal !== null && plan.days_to_renewal < 0 ? 'crm-due-over' : ''}>
                        renews {inDays(plan.days_to_renewal)}
                      </div>
                    </td>
                    <td className="crm-num">
                      {rupees(plan.amount)}
                      <div className="crm-sub">
                        <StateText value={plan.payment_status} />
                      </div>
                    </td>
                    <td>
                      <div className="crm-row-actions">
                        <button type="button" className="link-btn" onClick={() => setPlanEditing(plan)}>
                          Edit
                        </button>
                        <button type="button" className="link-btn" onClick={() => removePlan(plan)}>
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {customer.interactions.length > 0 && (
        <div>
          <div className="cu-record-head">
            <span className="crm-field-label">Recent calls</span>
          </div>
          <div className="crm-timeline">
            {customer.interactions.slice(0, 8).map((row) => (
              <div className="crm-event" key={row.id}>
                <span className="crm-event-dot" />
                <div>
                  <div className="crm-event-body">
                    {row.disposition_name ?? 'Call'} — {row.remarks ?? 'no remarks'}
                  </div>
                  <div className="crm-event-when">
                    {row.direction} · {row.staff_name ?? 'unknown'} · {dateTime(row.created_at)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {(addingPlan || planEditing) && (
        <PlanForm
          customerId={customer.id}
          plan={planEditing}
          onClose={() => {
            setAddingPlan(false)
            setPlanEditing(null)
          }}
          onSaved={() => {
            setAddingPlan(false)
            setPlanEditing(null)
            onChanged()
          }}
        />
      )}
    </div>
  )
}

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
