/* My Leads — the pipeline, as a table or as a board.
 *
 * Two views of one query, and the query lives on the server: a pipeline is the
 * one list in this product that genuinely reaches tens of thousands of rows, so
 * filtering and paging happen in SQL rather than in the browser. Everything the
 * footer says ("1–25 of 812") comes from the same response as the rows, because
 * a second count request is a second answer that can disagree.
 *
 * The board is the same rows in different furniture. Dragging a card between
 * columns is a stage change and goes through the same endpoint the drawer's
 * dropdown does — so a drag is on the lead's timeline exactly like a click.
 * Kanban is capped at one page for a reason: a column cannot be paginated, and
 * an infinite board that silently shows the first 200 of 812 is a board that
 * lies about the pipeline.
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import '../../styles/crm.css'
import { download } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { dateTime, relativeTime, shortDate } from '../../lib/format'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import {
  IconClose,
  IconDownload,
  IconFilter,
  IconGrid,
  IconPlus,
  IconSearch,
  IconSheet,
  IconUsers,
} from '../../components/Icons'
import {
  crm,
  crmError,
  daysFromTodayISO,
  isoToLocalInput,
  localToISO,
  qs,
  rupeesShort,
  todayISO,
  type Lead,
  type LeadDetail,
  type LeadPage,
  type LeadStatus,
} from './api'
import {
  CrmPage,
  Dialog,
  Drawer,
  DueDate,
  Field,
  LeadName,
  MasterSelect,
  OwnerSelect,
  StagePill,
  WhatsAppButton,
  useSelection,
} from './parts'

const PAGE_SIZES = [25, 50, 100]

export default function MyLeads() {
  const [params, setParams] = useSearchParams()

  const [view, setView] = useState<'table' | 'kanban'>('table')
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [statusId, setStatusId] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [followUp, setFollowUp] = useState(params.get('follow_up') ?? '')
  const [from, setFrom] = useState(daysFromTodayISO(-90))
  const [to, setTo] = useState(todayISO())
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [showFilters, setShowFilters] = useState(false)

  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Lead | null>(null)
  const [openLeadId, setOpenLeadId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)

  // The search box runs on the server, so it is debounced: a keystroke per
  // request would be twelve queries for one name.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQ(q.trim())
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [q])

  const query = {
    q: debouncedQ || undefined,
    status_id: statusId || undefined,
    source_id: sourceId || undefined,
    owner_id: ownerId || undefined,
    follow_up: followUp || undefined,
    date_from: from || undefined,
    date_to: to || undefined,
    page,
    // The board loads one page and says so; see the note at the top.
    page_size: view === 'kanban' ? 200 : pageSize,
  }

  const key = `crm-leads-${JSON.stringify(query)}-${view}`
  const leads = useQuery<LeadPage>(key, () => crm.leads(query))
  const statuses = useQuery<LeadStatus[]>('crm-statuses', () => crm.masters<LeadStatus>('statuses'))

  const rows = leads.data?.rows ?? []
  const selection = useSelection(rows)

  const filtered =
    debouncedQ !== '' || statusId !== '' || sourceId !== '' || ownerId !== '' || followUp !== ''

  function clearFilters() {
    setQ('')
    setStatusId('')
    setSourceId('')
    setOwnerId('')
    setFollowUp('')
    setPage(1)
    setParams({}, { replace: true })
  }

  /* The export carries the filters the table is showing, and nothing else. An
     export that quietly returns more rows than the screen is a data leak with a
     download button on it — the server applies the same scope either way, and
     this keeps the two views of "what I asked for" in step. */
  async function exportCsv() {
    setRowError(null)
    try {
      await download(
        `/crm/leads/export${qs({
          q: debouncedQ,
          status_id: statusId,
          source_id: sourceId,
          owner_id: ownerId,
          date_from: from,
          date_to: to,
        })}`,
        `leads-${todayISO()}.csv`,
      )
    } catch (err) {
      setRowError(crmError(err, 'The export could not be produced'))
    }
  }

  if (leads.error && !leads.data) {
    return (
      <CrmPage title="My Leads">
        <ErrorNote>{crmError(leads.cause, 'Could not load your leads')}</ErrorNote>
      </CrmPage>
    )
  }

  const total = leads.data?.total ?? 0
  const lastPage = Math.max(1, Math.ceil(total / pageSize))
  const firstRow = total === 0 ? 0 : (page - 1) * pageSize + 1
  const lastRow = Math.min(page * pageSize, total)

  return (
    <CrmPage
      title="My Leads"
      subtitle="Track, assign and convert your leads"
      actions={
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          <IconPlus size={15} /> Add Lead
        </button>
      }
    >
      <div className="crm-bar">
        <div className="crm-search">
          <IconSearch size={15} />
          <input
            type="search"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Search name, mobile, email…"
            aria-label="Search leads"
          />
        </div>
        <MasterSelect
          kind="statuses"
          value={statusId}
          onChange={(value) => {
            setStatusId(value)
            setPage(1)
          }}
          placeholder="All statuses"
        />
        <select
          value={followUp}
          onChange={(event) => {
            setFollowUp(event.target.value)
            setPage(1)
          }}
          aria-label="Follow-up"
        >
          <option value="">Any follow-up</option>
          <option value="today">Due today</option>
          <option value="overdue">Overdue</option>
          <option value="upcoming">Upcoming</option>
          <option value="none">No follow-up booked</option>
        </select>
        <button className="crm-tab" onClick={() => setShowFilters((open) => !open)}>
          <IconFilter size={14} /> Filters
        </button>
        {filtered && (
          <button className="filter-reset" onClick={clearFilters}>
            <IconClose size={13} /> Clear
          </button>
        )}
        <div className="crm-push crm-seg">
          <button
            className={view === 'table' ? 'crm-seg-on' : ''}
            onClick={() => setView('table')}
          >
            <IconSheet size={14} /> Table
          </button>
          <button
            className={view === 'kanban' ? 'crm-seg-on' : ''}
            onClick={() => setView('kanban')}
          >
            <IconGrid size={14} /> Kanban
          </button>
        </div>
        <button className="crm-icon-btn" onClick={exportCsv} title="Export this view as CSV">
          <IconDownload size={16} />
        </button>
        <button className="crm-icon-btn" onClick={() => setImporting(true)} title="Import from a file">
          <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
            <IconDownload size={16} />
          </span>
        </button>
      </div>

      {showFilters && (
        <section className="card" style={{ marginBottom: 14, padding: 14 }}>
          <div className="crm-grid-4">
            <Field label="Source">
              <MasterSelect
                kind="sources"
                value={sourceId}
                onChange={(value) => {
                  setSourceId(value)
                  setPage(1)
                }}
                placeholder="All sources"
              />
            </Field>
            <Field label="Owner">
              <OwnerSelect
                value={ownerId}
                onChange={(value) => {
                  setOwnerId(value)
                  setPage(1)
                }}
                placeholder="All users"
              />
            </Field>
            <Field label="Created from">
              <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </Field>
            <Field label="Created to">
              <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </Field>
          </div>
        </section>
      )}

      {banner && (
        <div className="notice notice-ok" style={{ marginBottom: 12 }}>
          {banner}
          <button className="link-btn" onClick={() => setBanner(null)}>
            Dismiss
          </button>
        </div>
      )}
      {rowError && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{rowError}</ErrorNote>
        </div>
      )}

      {selection.selected.size > 0 && (
        <BulkBar
          count={selection.selected.size}
          onAssign={async (owner) => {
            setRowError(null)
            try {
              const result = await crm.assignLeads({
                lead_ids: [...selection.selected],
                owner_id: owner || null,
              })
              setBanner(`${result.moved} lead${result.moved === 1 ? '' : 's'} reassigned.`)
              selection.clear()
              leads.reload()
            } catch (err) {
              setRowError(crmError(err, 'Those leads could not be reassigned'))
            }
          }}
          onClear={selection.clear}
        />
      )}

      {view === 'kanban' ? (
        <KanbanBoard
          rows={rows}
          statuses={statuses.data ?? []}
          total={total}
          loading={leads.loading}
          onOpen={setOpenLeadId}
          onMove={async (leadId, status) => {
            setRowError(null)
            try {
              await crm.moveLead(leadId, { status_id: status })
              leads.reload()
            } catch (err) {
              setRowError(crmError(err, 'That lead could not be moved'))
            }
          }}
        />
      ) : (
        <section className="card" style={{ opacity: leads.refetching ? 0.6 : 1 }}>
          {rows.length === 0 ? (
            leads.loading ? (
              <Loading />
            ) : filtered ? (
              <EmptyState
                icon={<IconUsers size={22} />}
                title="No leads match these filters"
                body="Clear the filters, or widen the date range — the list only covers what was created between the two dates."
              />
            ) : (
              <EmptyState
                icon={<IconUsers size={22} />}
                title="No leads yet"
                body="Add the first enquiry by hand, import a spreadsheet, or switch on lead capture in CRM Settings so your ads write straight into this list."
                action={
                  <button className="btn btn-primary" onClick={() => setAdding(true)}>
                    Add the first lead
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
                      <th style={{ width: 34 }}>
                        <input
                          type="checkbox"
                          checked={selection.selected.size === rows.length}
                          onChange={selection.toggleAll}
                          aria-label="Select every lead on this page"
                        />
                      </th>
                      <th>Lead ID</th>
                      <th>Lead name</th>
                      <th>Company</th>
                      <th>Mobile</th>
                      <th>Product / Service</th>
                      <th>Source</th>
                      <th>Status</th>
                      <th>Assigned</th>
                      <th>Follow-up</th>
                      <th>Created</th>
                      <th style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((lead) => (
                      <tr key={lead.id}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selection.isSelected(lead.id)}
                            onChange={() => selection.toggle(lead.id)}
                            aria-label={`Select ${lead.name}`}
                          />
                        </td>
                        <td>
                          <button className="link-btn crm-code" onClick={() => setOpenLeadId(lead.id)}>
                            #{lead.code}
                          </button>
                        </td>
                        <td>
                          <button className="link-btn" onClick={() => setOpenLeadId(lead.id)}>
                            <LeadName lead={lead} />
                          </button>
                        </td>
                        <td>{lead.company ?? <span className="crm-muted">—</span>}</td>
                        <td className="crm-nowrap">{lead.mobile}</td>
                        <td>{lead.product_name ?? <span className="crm-muted">—</span>}</td>
                        <td>{lead.source_name ?? <span className="crm-muted">—</span>}</td>
                        <td>
                          <StagePill name={lead.status_name} colour={lead.status_colour} />
                        </td>
                        <td>
                          {lead.owner_name ?? <span className="crm-muted">Unassigned</span>}
                        </td>
                        <td className="crm-nowrap">
                          <DueDate iso={lead.next_follow_up_at} />
                        </td>
                        <td className="crm-nowrap crm-sub">{shortDate(lead.created_at)}</td>
                        <td>
                          <div className="crm-row-actions">
                            <button
                              className="crm-icon-btn"
                              onClick={() => setEditing(lead)}
                              title="Edit this lead"
                              aria-label={`Edit ${lead.name}`}
                            >
                              <IconSheet size={15} />
                            </button>
                            <WhatsAppButton mobile={lead.whatsapp ?? lead.mobile} />
                            <button
                              className="crm-icon-btn"
                              onClick={() => setOpenLeadId(lead.id)}
                              title="Open the full record"
                              aria-label={`Open ${lead.name}`}
                            >
                              ⋮
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
                  {firstRow}–{lastRow} of {total} lead{total === 1 ? '' : 's'}
                </span>
                <label className="crm-sub" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  Rows
                  <select
                    value={pageSize}
                    onChange={(event) => {
                      setPageSize(Number(event.target.value))
                      setPage(1)
                    }}
                    aria-label="Rows per page"
                  >
                    {PAGE_SIZES.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="crm-pager">
                  <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
                    ‹
                  </button>
                  <button className="crm-page-on">{page}</button>
                  <button
                    disabled={page >= lastPage}
                    onClick={() => setPage((p) => p + 1)}
                    aria-label="Next page"
                  >
                    ›
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      )}

      {(adding || editing) && (
        <LeadForm
          lead={editing}
          onClose={() => {
            setAdding(false)
            setEditing(null)
          }}
          onSaved={() => {
            setAdding(false)
            setEditing(null)
            leads.reload()
          }}
        />
      )}

      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onDone={(created, skipped) => {
            setImporting(false)
            setBanner(`${created} lead${created === 1 ? '' : 's'} imported, ${skipped} skipped as duplicates.`)
            leads.reload()
          }}
        />
      )}

      {openLeadId && (
        <LeadDrawer
          leadId={openLeadId}
          onClose={() => setOpenLeadId(null)}
          onChanged={() => leads.reload()}
        />
      )}
    </CrmPage>
  )
}

/* ------------------------------------------------------------- bulk actions --- */

function BulkBar({
  count,
  onAssign,
  onClear,
}: {
  count: number
  onAssign: (ownerId: string) => void
  onClear: () => void
}) {
  const [owner, setOwner] = useState('')
  return (
    <div className="crm-selection">
      <strong>{count}</strong> selected
      <OwnerSelect value={owner} onChange={setOwner} placeholder="Return to the unassigned pool" />
      <button className="btn btn-sm btn-primary" onClick={() => onAssign(owner)}>
        Assign
      </button>
      <button className="link-btn" onClick={onClear}>
        Clear selection
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------- board --- */

function KanbanBoard({
  rows,
  statuses,
  total,
  loading,
  onOpen,
  onMove,
}: {
  rows: Lead[]
  statuses: LeadStatus[]
  total: number
  loading: boolean
  onOpen: (id: string) => void
  onMove: (leadId: string, statusId: string) => void
}) {
  const [over, setOver] = useState<string | null>(null)
  const dragging = useRef<string | null>(null)

  const columns = useMemo(
    () =>
      statuses
        .filter((status) => status.is_active)
        .map((status) => ({
          status,
          leads: rows.filter((lead) => lead.status_id === status.id),
        })),
    [statuses, rows],
  )

  if (loading && rows.length === 0) return <Loading />
  if (columns.length === 0) {
    return (
      <section className="card">
        <EmptyState
          title="No stages to build a board from"
          body="Add lead statuses in CRM Settings — the board draws one column per stage."
        />
      </section>
    )
  }

  return (
    <>
      {total > rows.length && (
        <p className="crm-sub" style={{ marginBottom: 8 }}>
          Showing the {rows.length} most recent of {total} leads. A column cannot be paged, so the
          board is capped — use the table to work through the whole pipeline.
        </p>
      )}
      <div className="crm-board">
        {columns.map(({ status, leads }) => (
          <div
            key={status.id}
            className={`crm-col${over === status.id ? ' crm-col-over' : ''}`}
            onDragOver={(event) => {
              event.preventDefault()
              setOver(status.id)
            }}
            onDragLeave={() => setOver((current) => (current === status.id ? null : current))}
            onDrop={(event) => {
              event.preventDefault()
              setOver(null)
              const id = dragging.current ?? event.dataTransfer.getData('text/plain')
              dragging.current = null
              // Dropping a card back where it started is not a stage change and
              // must not write a timeline entry saying it was.
              if (id && !leads.some((lead) => lead.id === id)) onMove(id, status.id)
            }}
          >
            <div className="crm-col-head">
              <span className="crm-pill-dot" style={{ background: status.colour }} />
              <span className="crm-col-name">{status.name}</span>
              <span className="crm-col-count">{leads.length}</span>
            </div>
            <div className="crm-col-body">
              {leads.length === 0 && <p className="crm-sub">Nothing here.</p>}
              {leads.map((lead) => (
                <article
                  key={lead.id}
                  className="crm-card"
                  draggable
                  onDragStart={(event) => {
                    dragging.current = lead.id
                    event.dataTransfer.setData('text/plain', lead.id)
                    event.dataTransfer.effectAllowed = 'move'
                  }}
                  onClick={() => onOpen(lead.id)}
                >
                  <div className="crm-card-name">{lead.name}</div>
                  {lead.company && <div className="crm-sub">{lead.company}</div>}
                  <div className="crm-card-meta">
                    <span className="crm-code">#{lead.code}</span>
                    {lead.value && <span>{rupeesShort(lead.value)}</span>}
                  </div>
                  <div className="crm-card-meta">
                    <span>{lead.owner_name ?? 'Unassigned'}</span>
                    {lead.next_follow_up_at && (
                      <span className="crm-push">
                        <DueDate iso={lead.next_follow_up_at} />
                      </span>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------- form --- */

function LeadForm({
  lead,
  onClose,
  onSaved,
}: {
  lead: Lead | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(lead?.name ?? '')
  const [company, setCompany] = useState(lead?.company ?? '')
  const [mobile, setMobile] = useState(lead?.mobile ?? '')
  const [email, setEmail] = useState(lead?.email ?? '')
  // "Same as mobile" is the default because it is true nine times in ten, and
  // the server applies the same rule when the field is left empty.
  const [sameNumber, setSameNumber] = useState(
    lead ? (lead.whatsapp ?? lead.mobile) === lead.mobile : true,
  )
  const [whatsapp, setWhatsapp] = useState(lead?.whatsapp ?? '')
  const [sourceId, setSourceId] = useState(lead?.source_id ?? '')
  const [industryId, setIndustryId] = useState(lead?.industry_id ?? '')
  const [productId, setProductId] = useState(lead?.product_id ?? '')
  const [ownerId, setOwnerId] = useState(lead?.owner_id ?? '')
  const [statusId, setStatusId] = useState(lead?.status_id ?? '')
  const [pincode, setPincode] = useState(lead?.pincode ?? '')
  const [countryId, setCountryId] = useState('')
  const [stateId, setStateId] = useState(lead?.state_id ?? '')
  const [cityId, setCityId] = useState(lead?.city_id ?? '')
  const [address, setAddress] = useState(lead?.address ?? '')
  const [value, setValue] = useState(lead?.value ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const countries = useQuery('crm-countries', () => crm.masters('countries'))
  useEffect(() => {
    if (!countryId && countries.data && countries.data.length > 0) {
      setCountryId(countries.data[0].id)
    }
  }, [countries.data, countryId])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    const body = {
      name,
      company: company || null,
      mobile,
      whatsapp: sameNumber ? mobile : whatsapp || null,
      email: email || null,
      source_id: sourceId || null,
      industry_id: industryId || null,
      product_id: productId || null,
      owner_id: ownerId || null,
      status_id: statusId || null,
      state_id: stateId || null,
      city_id: cityId || null,
      pincode: pincode || null,
      address: address || null,
      value: value || null,
    }
    try {
      if (lead) await crm.patchLead(lead.id, body)
      else await crm.createLead(body)
      onSaved()
    } catch (err) {
      setError(crmError(err, 'That lead could not be saved'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      title={lead ? `Edit ${lead.name}` : 'Add Lead'}
      onClose={onClose}
      footer={
        <>
          {error && <ErrorNote>{error}</ErrorNote>}
          <button className="btn" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn btn-primary"
            form="crm-lead-form"
            type="submit"
            disabled={saving || !name.trim() || !mobile.trim()}
          >
            {saving ? 'Saving…' : 'Save Lead'}
          </button>
        </>
      }
    >
      <form className="crm-form" id="crm-lead-form" onSubmit={submit}>
        <Field label="Name *">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Full name"
            autoFocus
            required
          />
        </Field>
        <Field label="Company">
          <input
            value={company}
            onChange={(event) => setCompany(event.target.value)}
            placeholder="Company / firm name"
          />
        </Field>

        <Field label="Mobile *">
          <input
            value={mobile}
            onChange={(event) => setMobile(event.target.value)}
            placeholder="Mobile number"
            required
          />
        </Field>
        <Field label="Email">
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="email@example.com"
          />
        </Field>

        <div className="crm-field">
          <span className="crm-field-label">WhatsApp</span>
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
        <Field label="Lead Source">
          <MasterSelect kind="sources" value={sourceId} onChange={setSourceId} />
        </Field>

        <Field label="Industry Type">
          <MasterSelect kind="industries" value={industryId} onChange={setIndustryId} />
        </Field>
        <Field label="Product / Service Type">
          <MasterSelect kind="products" value={productId} onChange={setProductId} />
        </Field>

        <Field label="Lead Owner">
          <OwnerSelect value={ownerId} onChange={setOwnerId} />
        </Field>
        <Field label="Pincode">
          <input
            value={pincode}
            onChange={(event) => setPincode(event.target.value)}
            placeholder="Pincode"
          />
        </Field>

        <Field label="State">
          <MasterSelect
            kind="states"
            value={stateId}
            onChange={(next) => {
              setStateId(next)
              // A city belongs to a state; keeping the old one would leave a
              // lead in a city that is not in the state it claims.
              setCityId('')
            }}
            parentId={countryId || undefined}
          />
        </Field>
        <Field label="City">
          <MasterSelect kind="cities" value={cityId} onChange={setCityId} parentId={stateId} />
        </Field>

        {lead && (
          <>
            <Field label="Stage">
              <MasterSelect kind="statuses" value={statusId} onChange={setStatusId} />
            </Field>
            <Field label="Expected value" hint="Optional — leave it blank rather than guessing.">
              <input
                value={value ?? ''}
                onChange={(event) => setValue(event.target.value)}
                inputMode="decimal"
                placeholder="0.00"
              />
            </Field>
          </>
        )}

        <Field label="Address" wide>
          <textarea
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            rows={3}
            placeholder="Full address"
          />
        </Field>
      </form>
    </Dialog>
  )
}

/* ----------------------------------------------------------------- import --- */

/** CSV import. Parsed in the browser and posted as rows, so the server never
 *  has to guess at an encoding or a delimiter — and the reader sees what will
 *  be created before anything is. */
function ImportDialog({
  onClose,
  onDone,
}: {
  onClose: () => void
  onDone: (created: number, skipped: number) => void
}) {
  const [rows, setRows] = useState<Array<Record<string, string>>>([])
  const [fileName, setFileName] = useState('')
  const [skipDuplicates, setSkipDuplicates] = useState(true)
  const [ownerId, setOwnerId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [problems, setProblems] = useState<string[]>([])

  async function readFile(file: File) {
    setError(null)
    setProblems([])
    const text = await file.text()
    const lines = text.split(/\r?\n/).filter((line) => line.trim())
    if (lines.length < 2) {
      setError('That file has a header but no rows.')
      return
    }
    const header = splitCsvLine(lines[0]).map((cell) => cell.trim().toLowerCase())
    const parsed = lines.slice(1).map((line) => {
      const cells = splitCsvLine(line)
      const row: Record<string, string> = {}
      header.forEach((column, index) => {
        row[column] = (cells[index] ?? '').trim()
      })
      return row
    })
    setFileName(file.name)
    setRows(parsed)
  }

  const mapped = rows
    .map((row) => ({
      name: row.name || row['lead name'] || row['full name'] || '',
      mobile: row.mobile || row.phone || row['mobile number'] || '',
      company: row.company || undefined,
      email: row.email || undefined,
      source: row.source || row['lead source'] || undefined,
      status: row.status || undefined,
      product: row.product || row['product / service'] || undefined,
      city: row.city || undefined,
      state: row.state || undefined,
      pincode: row.pincode || undefined,
      address: row.address || undefined,
      notes: row.notes || undefined,
    }))
    .filter((row) => row.name && row.mobile)

  async function run() {
    setBusy(true)
    setError(null)
    try {
      const result = await crm.importLeads({
        rows: mapped,
        skip_duplicates: skipDuplicates,
        owner_id: ownerId || null,
      })
      if (result.errors.length > 0) {
        setProblems(result.errors)
        setBusy(false)
        return
      }
      onDone(result.created, result.skipped)
    } catch (err) {
      setError(crmError(err, 'The import failed'))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Import leads"
      subtitle="A CSV with a header row. Name and Mobile are required; everything else is matched by name."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="btn btn-primary" onClick={run} disabled={busy || mapped.length === 0}>
            {busy ? 'Importing…' : `Import ${mapped.length} lead${mapped.length === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      <div className="crm-form">
        <Field label="File" wide>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void readFile(file)
            }}
          />
        </Field>
        <Field label="Assign every imported lead to">
          <OwnerSelect value={ownerId} onChange={setOwnerId} placeholder="Leave unassigned" />
        </Field>
        <div className="crm-field">
          <span className="crm-field-label">Duplicates</span>
          <label className="crm-check">
            <input
              type="checkbox"
              checked={skipDuplicates}
              onChange={(event) => setSkipDuplicates(event.target.checked)}
            />
            Skip a row whose mobile is already in the pipeline
          </label>
        </div>

        {error && (
          <div className="crm-form-wide">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}
        {problems.length > 0 && (
          <div className="crm-form-wide">
            <ErrorNote>
              <div>Some rows were refused:</div>
              <ul>
                {problems.slice(0, 8).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </ErrorNote>
          </div>
        )}

        {fileName && (
          <div className="crm-form-wide">
            <p className="crm-sub">
              {fileName} — {mapped.length} usable row{mapped.length === 1 ? '' : 's'}
              {rows.length !== mapped.length &&
                `, ${rows.length - mapped.length} skipped for a missing name or mobile`}
            </p>
            <div className="table-wrap" style={{ maxHeight: 240 }}>
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Mobile</th>
                    <th>Company</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {mapped.slice(0, 25).map((row, index) => (
                    <tr key={`${row.mobile}-${index}`}>
                      <td>{row.name}</td>
                      <td>{row.mobile}</td>
                      <td>{row.company ?? '—'}</td>
                      <td>{row.source ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  )
}

/** Split one CSV line, honouring quoted cells containing commas.
 *
 * Deliberately small rather than a library: the format this reads is "what
 * Excel saves", and the only thing that actually breaks a naive split is a
 * quoted comma in an address. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"'
        i++
      } else quoted = !quoted
    } else if (char === ',' && !quoted) {
      cells.push(current)
      current = ''
    } else current += char
  }
  cells.push(current)
  return cells.map((cell) => cell.replace(/^"|"$/g, ''))
}

/* ----------------------------------------------------------------- drawer --- */

function LeadDrawer({
  leadId,
  onClose,
  onChanged,
}: {
  leadId: string
  onClose: () => void
  onChanged: () => void
}) {
  const detail = useQuery<LeadDetail>(`crm-lead-${leadId}`, () => crm.lead(leadId))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [booking, setBooking] = useState(false)
  const [converting, setConverting] = useState(false)

  const lead = detail.data

  async function addNote() {
    if (!note.trim()) return
    setBusy(true)
    try {
      await crm.addActivity(leadId, { body: note.trim(), kind: 'note' })
      setNote('')
      detail.reload()
    } catch (err) {
      setError(crmError(err, 'That note could not be saved'))
    } finally {
      setBusy(false)
    }
  }

  async function move(statusId: string) {
    setError(null)
    try {
      await crm.moveLead(leadId, { status_id: statusId })
      detail.reload()
      onChanged()
    } catch (err) {
      setError(crmError(err, 'That stage could not be set'))
    }
  }

  return (
    <Drawer
      title={lead ? lead.name : 'Lead'}
      meta={lead ? `#${lead.code} · ${lead.mobile}` : undefined}
      onClose={onClose}
      footer={
        lead && (
          <>
            <button className="btn btn-sm" onClick={() => setBooking(true)}>
              Book a follow-up
            </button>
            {!lead.customer_id && (
              <button className="btn btn-sm btn-primary" onClick={() => setConverting(true)}>
                Convert to customer
              </button>
            )}
            <WhatsAppButton mobile={lead.whatsapp ?? lead.mobile} />
          </>
        )
      }
    >
      {!lead ? (
        <Loading />
      ) : (
        <>
          {error && <ErrorNote>{error}</ErrorNote>}

          <div className="crm-facts" style={{ padding: 0 }}>
            <div>
              <div className="crm-fact-label">Stage</div>
              <div className="crm-fact-value">
                <MasterSelect kind="statuses" value={lead.status_id ?? ''} onChange={move} />
              </div>
            </div>
            <div>
              <div className="crm-fact-label">Owner</div>
              <div className="crm-fact-value">{lead.owner_name ?? 'Unassigned'}</div>
            </div>
            <div>
              <div className="crm-fact-label">Source</div>
              <div className="crm-fact-value">{lead.source_name ?? '—'}</div>
            </div>
            <div>
              <div className="crm-fact-label">Product</div>
              <div className="crm-fact-value">{lead.product_name ?? '—'}</div>
            </div>
            <div>
              <div className="crm-fact-label">Next follow-up</div>
              <div className="crm-fact-value">
                <DueDate iso={lead.next_follow_up_at} />
              </div>
            </div>
            <div>
              <div className="crm-fact-label">Created</div>
              <div className="crm-fact-value">{dateTime(lead.created_at)}</div>
            </div>
          </div>

          {lead.customer_id && (
            <div className="notice notice-ok">
              Converted {lead.converted_at ? relativeTime(lead.converted_at) : ''} — this lead is
              now a customer.
            </div>
          )}
          {lead.lost_reason && <div className="notice notice-warn">Lost: {lead.lost_reason}</div>}

          <div>
            <div className="crm-field-label" style={{ marginBottom: 6 }}>
              Add a note
            </div>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              placeholder="What was said?"
            />
            <button
              className="btn btn-sm"
              style={{ marginTop: 6 }}
              onClick={addNote}
              disabled={busy || !note.trim()}
            >
              Save note
            </button>
          </div>

          {lead.follow_ups.length > 0 && (
            <div>
              <div className="crm-field-label" style={{ marginBottom: 6 }}>
                Follow-ups
              </div>
              <div className="crm-timeline">
                {lead.follow_ups.map((row) => (
                  <div className="crm-event" key={row.id}>
                    <span className="crm-event-dot" />
                    <div>
                      <div className="crm-event-body">
                        {row.purpose ?? 'Follow-up'} — <DueDate iso={row.due_at} overdue={row.is_overdue} />
                      </div>
                      <div className="crm-event-when">
                        {row.status}
                        {row.outcome ? ` · ${row.outcome}` : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="crm-field-label" style={{ marginBottom: 6 }}>
              Timeline
            </div>
            <div className="crm-timeline">
              {lead.activities.length === 0 && <p className="empty">Nothing recorded yet.</p>}
              {lead.activities.map((event) => (
                <div className={`crm-event crm-event-${event.kind}`} key={event.id}>
                  <span className="crm-event-dot" />
                  <div>
                    <div className="crm-event-body">{event.body}</div>
                    <div className="crm-event-when">
                      {event.actor_name ?? 'System'} · {relativeTime(event.created_at)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {booking && (
            <FollowUpDialog
              leadId={lead.id}
              onClose={() => setBooking(false)}
              onSaved={() => {
                setBooking(false)
                detail.reload()
                onChanged()
              }}
            />
          )}

          {converting && (
            <ConvertDialog
              lead={lead}
              onClose={() => setConverting(false)}
              onDone={() => {
                setConverting(false)
                detail.reload()
                onChanged()
              }}
            />
          )}
        </>
      )}
    </Drawer>
  )
}

/** Book a follow-up against a lead. Exported because Follow-ups and the support
 *  desk open the same dialog rather than each growing their own. */
export function FollowUpDialog({
  leadId,
  customerId,
  onClose,
  onSaved,
}: {
  leadId?: string
  customerId?: string
  onClose: () => void
  onSaved: () => void
}) {
  const [due, setDue] = useState(() => {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(10, 0, 0, 0)
    return isoToLocalInput(tomorrow.toISOString())
  })
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
        lead_id: leadId ?? null,
        customer_id: customerId ?? null,
        due_at: localToISO(due),
        purpose: purpose || null,
        notes: notes || null,
        owner_id: ownerId || null,
      })
      onSaved()
    } catch (err) {
      setError(crmError(err, 'That follow-up could not be booked'))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Book a follow-up"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !due}>
            {busy ? 'Booking…' : 'Book it'}
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
        <Field label="When">
          <input
            type="datetime-local"
            value={due}
            onChange={(event) => setDue(event.target.value)}
            autoFocus
          />
        </Field>
        <Field label="Owner" hint="Defaults to whoever owns the record.">
          <OwnerSelect value={ownerId} onChange={setOwnerId} placeholder="Whoever owns it" />
        </Field>
        <Field label="Purpose" wide>
          <input
            value={purpose}
            onChange={(event) => setPurpose(event.target.value)}
            placeholder="Send pricing, confirm the demo…"
          />
        </Field>
        <Field label="Notes" wide>
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} />
        </Field>
      </div>
    </Dialog>
  )
}

function ConvertDialog({
  lead,
  onClose,
  onDone,
}: {
  lead: LeadDetail
  onClose: () => void
  onDone: () => void
}) {
  const [code, setCode] = useState('')
  const [managerId, setManagerId] = useState(lead.owner_id ?? '')
  const [gstin, setGstin] = useState('')
  const [withPlan, setWithPlan] = useState(true)
  const [productId, setProductId] = useState(lead.product_id ?? '')
  const [planId, setPlanId] = useState('')
  const [startOn, setStartOn] = useState(todayISO())
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function convert() {
    setBusy(true)
    setError(null)
    try {
      await crm.convertLead(lead.id, {
        code: code || null,
        manager_id: managerId || null,
        gstin: gstin || null,
        plan: withPlan
          ? {
              product_id: productId || null,
              plan_id: planId || null,
              start_on: startOn,
              amount: amount || '0',
            }
          : null,
      })
      onDone()
    } catch (err) {
      setError(crmError(err, 'That lead could not be converted'))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={`Convert ${lead.name}`}
      subtitle="The customer record is filled in from the lead. Everything here is optional."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={convert} disabled={busy}>
            {busy ? 'Converting…' : 'Convert to customer'}
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
        <Field label="Customer ID" hint="Your own reference. Generated when left blank.">
          <input value={code} onChange={(event) => setCode(event.target.value)} />
        </Field>
        <Field label="Account manager">
          <OwnerSelect value={managerId} onChange={setManagerId} />
        </Field>
        <Field label="GSTIN">
          <input value={gstin} onChange={(event) => setGstin(event.target.value)} placeholder="27AAAAA0000A1Z5" />
        </Field>
        <div className="crm-field">
          <span className="crm-field-label">What they bought</span>
          <label className="crm-check">
            <input
              type="checkbox"
              checked={withPlan}
              onChange={(event) => setWithPlan(event.target.checked)}
            />
            Record a plan now
          </label>
        </div>

        {withPlan && (
          <>
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
            <Field label="Starts on">
              <input type="date" value={startOn} onChange={(event) => setStartOn(event.target.value)} />
            </Field>
            <Field label="Amount">
              <input
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                inputMode="decimal"
                placeholder="0.00"
              />
            </Field>
          </>
        )}
      </div>
    </Dialog>
  )
}
