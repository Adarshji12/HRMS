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

import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import '../../styles/crm.css'
import '../../styles/leads.css'
import { download } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { blankDeal, dealFromOpportunity, dealBlocked, dealIncomplete, dealFilesTooBig, dealMandatoryMissing, dealStarted, LeadDealFields, saveDeal, uploadDealFiles } from './LeadDealFields'
import {
  IconBriefcase,
  IconCheck,
  IconClose,
  IconDownload,
  IconEdit,
  IconFilter,
  IconGrid,
  IconMail,
  IconPhone,
  IconPin,
  IconPlus,
  IconSearch,
  IconSheet,
  IconStar,
  IconTrash,
  IconUpload,
  IconUser,
  IconUsers,
} from '../../components/Icons'
import {
  crm,
  crmError,
  daysFromTodayISO,
  isoToLocalInput,
  localToISO,
  qs,
  rupees,
  rupeesShort,
  todayISO,
  type Country,
  type Lead,
  type LeadDetail,
  type LeadPage,
  type LeadStatus,
  type Opportunity,
} from './api'
import {
  Assignee,
  CrmPage,
  Dialog,
  DuePill,
  DueDate,
  LfField,
  LfInput,
  LfSection,
  Field,
  ItemSelect,
  MasterSelect,
  OwnerSelect,
  StagePill,
  WhatsAppButton,
  useSelection,
  ThCaret,
  nationalDigits,
  onlyDigits,
  withDialCode,
} from './parts'
import { LeadEmailDialog } from './LeadEmail'
import { ColumnSettings, FieldSettings, useColumns, useFieldModes, type ColumnDef, type FieldDef, type FieldSection } from '../../components/ViewSettings'

const PAGE_SIZES = [25, 50, 100]

/** What the leads table can show. A person picks and orders these from Settings;
 *  the first five are what it shows until they do. */
type LeadColumn = ColumnDef & { td: (lead: Lead) => ReactNode; className?: string }
const dash = <span className="crm-muted">—</span>
const LEAD_COLUMNS: LeadColumn[] = [
  { key: 'lead', label: 'Lead', locked: true, td: (l) => (
    /* Name first, the lead ID and email beneath it. */
    <Link className="crm-lead-name" to={`/crm/leads/${l.id}`}>
      <span className="crm-strong">{l.name}</span>
      <span className="crm-lead-email">
        <span className="crm-lead-code">#{l.code}</span>
        {l.email && <> · {l.email}</>}
      </span>
    </Link>
  ) },
  { key: 'mobile', label: 'Mobile', className: 'crm-nowrap crm-num-plain', td: (l) => l.mobile },
  { key: 'status', label: 'Status', td: (l) => <StagePill name={l.status_name} colour={l.status_colour} /> },
  { key: 'owner', label: 'Assigned', td: (l) => <Assignee name={l.owner_name} /> },
  { key: 'followup', label: 'Follow-up', className: 'crm-nowrap', td: (l) => <DuePill iso={l.next_follow_up_at} /> },
  { key: 'company', label: 'Company', initial: false, td: (l) => l.company ?? dash },
  { key: 'email', label: 'Email', initial: false, td: (l) => l.email ?? dash },
  { key: 'source', label: 'Source', initial: false, td: (l) => l.source_name ?? dash },
  { key: 'item', label: 'Item', initial: false, td: (l) => l.product_name ?? dash },
  { key: 'industry', label: 'Industry', initial: false, td: (l) => l.industry_name ?? dash },
  { key: 'state', label: 'State', initial: false, td: (l) => l.state_name ?? dash },
  { key: 'city', label: 'City', initial: false, td: (l) => l.city_name ?? dash },
  { key: 'pincode', label: 'Pincode', initial: false, td: (l) => l.pincode ?? dash },
  { key: 'value', label: 'Expected revenue', initial: false, className: 'crm-nowrap', td: (l) => (l.value ? rupees(l.value) : dash) },
  { key: 'whatsapp', label: 'WhatsApp', initial: false, className: 'crm-nowrap', td: (l) => l.whatsapp ?? dash },
  { key: 'address', label: 'Address', initial: false, td: (l) => l.address ?? dash },
  { key: 'notes', label: 'Notes', initial: false, td: (l) => l.notes ?? dash },
  { key: 'lastcontact', label: 'Last contacted', initial: false, className: 'crm-nowrap', td: (l) => (l.last_contacted_at ? new Date(l.last_contacted_at).toLocaleDateString('en-IN') : dash) },
  { key: 'lost', label: 'Lost reason', initial: false, td: (l) => l.lost_reason ?? dash },
  { key: 'converted', label: 'Converted on', initial: false, className: 'crm-nowrap', td: (l) => (l.converted_at ? new Date(l.converted_at).toLocaleDateString('en-IN') : dash) },
  { key: 'updated', label: 'Updated', initial: false, className: 'crm-nowrap', td: (l) => new Date(l.updated_at).toLocaleDateString('en-IN') },
  { key: 'created', label: 'Created', initial: false, className: 'crm-nowrap', td: (l) => new Date(l.created_at).toLocaleDateString('en-IN') },
]

/** What the Add lead form can show, make mandatory or hide. A lead's name and
 *  mobile number are the two the server needs, so they cannot be changed. */
const LEAD_SECTIONS: FieldSection[] = [
  { id: 'customer', label: 'Customer info' },
  { id: 'lead', label: 'Lead info' },
  { id: 'address', label: 'Address' },
  { id: 'deal', label: 'Deal details' },
  { id: 'opportunity', label: 'Opportunity' },
]
const LEAD_FIELDS: FieldDef[] = [
  { key: 'name', label: 'Full name', section: 'customer', fixed: true },
  { key: 'company', label: 'Company', section: 'customer' },
  { key: 'mobile', label: 'Mobile number', section: 'customer', fixed: true },
  { key: 'email', label: 'Email', section: 'customer' },
  { key: 'whatsapp', label: 'WhatsApp', section: 'customer' },
  { key: 'source', label: 'Lead source', section: 'lead' },
  { key: 'owner', label: 'Lead owner', section: 'lead' },
  { key: 'industry', label: 'Industry type', section: 'lead' },
  { key: 'item', label: 'Item', section: 'lead' },
  { key: 'state', label: 'State', section: 'address' },
  { key: 'city', label: 'City', section: 'address' },
  { key: 'pincode', label: 'Pincode', section: 'address' },
  { key: 'address', label: 'Address', section: 'address' },
  { key: 'customer', label: 'Existing customer', section: 'deal' },
  { key: 'tags', label: 'Tags', section: 'deal' },
  { key: 'title', label: 'Opportunity name', section: 'opportunity' },
  { key: 'value', label: 'Expected revenue', section: 'opportunity' },
  { key: 'requirement', label: 'Requirement type', section: 'opportunity' },
  { key: 'oem', label: 'OEM', section: 'opportunity' },
  { key: 'raw_cost', label: 'Raw cost', section: 'opportunity' },
  { key: 'team', label: 'Sales team', section: 'opportunity' },
  { key: 'costsheet', label: 'Costsheet', section: 'opportunity' },
  { key: 'quotation', label: 'Quotation', section: 'opportunity' },
  { key: 'mail', label: 'Mail sent', section: 'opportunity', optionalOnly: true },
  { key: 'notes', label: 'Internal notes', section: 'opportunity' },
]

export default function MyLeads() {
  const [params, setParams] = useSearchParams()

  const [view, setView] = useState<'table' | 'kanban'>('table')
  const columns = useColumns('leads', LEAD_COLUMNS)
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [statusId, setStatusId] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [followUp, setFollowUp] = useState(params.get('follow_up') ?? '')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [showFilters, setShowFilters] = useState(false)
  const [industryId, setIndustryId] = useState('')
  const [productId, setProductId] = useState('')
  const [stateId, setStateId] = useState('')
  const [districtId, setDistrictId] = useState('')
  const [cityId, setCityId] = useState('')
  const filterRef = useRef<HTMLDivElement>(null)

  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Lead | null>(null)
  const [emailing, setEmailing] = useState<Lead | null>(null)
  const navigate = useNavigate()
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
    industry_id: industryId || undefined,
    product_id: productId || undefined,
    state_id: stateId || undefined,
    district_id: districtId || undefined,
    city_id: cityId || undefined,
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

  /* Every filter but search lives in the popover; they are counted for the badge
     on its button. Search and the date range stay on the toolbar. */
  const popoverCount = [statusId, followUp, ownerId, sourceId, industryId, productId, stateId, districtId, cityId]
    .filter(Boolean).length
  const filtered = debouncedQ !== '' || popoverCount > 0

  function resetPopover() {
    setStatusId(''); setFollowUp(''); setOwnerId('')
    setSourceId(''); setIndustryId(''); setProductId('')
    setStateId(''); setDistrictId(''); setCityId('')
    setPage(1)
  }

  /* The popover closes on a click outside it or on Escape. */
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

  function clearFilters() {
    setQ('')
    setStatusId('')
    setSourceId('')
    setOwnerId('')
    setFollowUp('')
    resetPopover()
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
          industry_id: industryId,
          product_id: productId,
          state_id: stateId,
          district_id: districtId,
          city_id: cityId,
          follow_up: followUp,
          date_from: from,
          date_to: to,
        })}`,
        `leads-${todayISO()}.csv`,
      )
    } catch (err) {
      setRowError(crmError(err, 'The export could not be produced'))
    }
  }

  async function remove(lead: Lead) {
    if (!window.confirm(`Delete the lead “${lead.name}”? This cannot be undone.`)) return
    setRowError(null)
    try {
      await crm.deleteLead(lead.id)
      leads.reload()
    } catch (err) {
      setRowError(crmError(err, 'That lead could not be deleted'))
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
    /* No page heading: "My Leads" is the tab above. One toolbar instead —
       finding on the left, the view and the actions on the right, Add Lead
       beside Import and Export where the other lead actions are. */
    <div className="crm">
      <div className="crm-bar ml-toolbar">
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
        <div className="ml-filter" ref={filterRef}>
          <button
            className={`crm-tab ml-filter-btn${popoverCount ? ' is-active' : ''}${showFilters ? ' is-open' : ''}`}
            onClick={() => setShowFilters((open) => !open)}
            aria-expanded={showFilters}
            aria-haspopup="dialog"
          >
            <IconFilter size={14} /> Filters
            {popoverCount > 0 && <span className="ml-filter-count">{popoverCount}</span>}
          </button>
          {showFilters && (
            /* Each change applies at once — the list updates behind the
               popover — so there is no Apply button to forget. */
            <div className="ml-pop" role="dialog" aria-label="Filter leads">
              <label className="ml-pop-field">
                <span>Status</span>
                <MasterSelect kind="statuses" value={statusId} placeholder="All statuses"
                              onChange={(v) => { setStatusId(v); setPage(1) }} />
              </label>
              <label className="ml-pop-field">
                <span>Follow-up</span>
                <select value={followUp} aria-label="Follow-up"
                        onChange={(event) => { setFollowUp(event.target.value); setPage(1) }}>
                  <option value="">Any follow-up</option>
                  <option value="today">Due today</option>
                  <option value="overdue">Overdue</option>
                  <option value="upcoming">Upcoming</option>
                  <option value="none">No follow-up booked</option>
                </select>
              </label>
              <label className="ml-pop-field">
                <span>Owner</span>
                <OwnerSelect value={ownerId} placeholder="All owners"
                             onChange={(v) => { setOwnerId(v); setPage(1) }} />
              </label>
              <label className="ml-pop-field">
                <span>Lead source</span>
                <MasterSelect kind="sources" value={sourceId} placeholder="All sources"
                              onChange={(v) => { setSourceId(v); setPage(1) }} />
              </label>
              <label className="ml-pop-field">
                <span>Industry</span>
                <MasterSelect kind="industries" value={industryId} placeholder="All industries"
                              onChange={(v) => { setIndustryId(v); setPage(1) }} />
              </label>
              <label className="ml-pop-field">
                <span>Item</span>
                <ItemSelect value={productId} placeholder="All items"
                            onChange={(v) => { setProductId(v); setPage(1) }} />
              </label>
              <label className="ml-pop-field">
                <span>State</span>
                <MasterSelect kind="states" value={stateId} placeholder="All states"
                              onChange={(v) => { setStateId(v); setDistrictId(''); setCityId(''); setPage(1) }} />
              </label>
              {/* District and city follow the state, and stay disabled
                  until one is chosen. */}
              <label className="ml-pop-field">
                <span>District</span>
                <MasterSelect kind="districts" parentId={stateId} value={districtId} placeholder="All districts"
                              onChange={(v) => { setDistrictId(v); setPage(1) }} />
              </label>
              <label className="ml-pop-field">
                <span>City</span>
                <MasterSelect kind="cities" parentId={stateId} value={cityId} placeholder="All cities"
                              onChange={(v) => { setCityId(v); setPage(1) }} />
              </label>
              <button type="button" className="ml-pop-reset ml-pop-wide" onClick={resetPopover}
                      disabled={popoverCount === 0}>
                Reset filters
              </button>
            </div>
          )}
        </div>
        <CreatedRange from={from} to={to}
                      onChange={(f, t) => { setFrom(f); setTo(t); setPage(1) }} />
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
        {view === 'table' && (
          <ColumnSettings defs={LEAD_COLUMNS} order={columns.pref.order} hidden={columns.pref.hidden}
                          onSave={columns.save} onReset={columns.reset} />
        )}
        <span className="ml-divider" aria-hidden />
        <button className="ml-icon-btn" onClick={() => setImporting(true)}
                title="Import leads from a file" aria-label="Import leads from a file">
          <IconUpload size={15} />
        </button>
        <button className="ml-icon-btn" onClick={exportCsv}
                title="Export this view as CSV" aria-label="Export this view as CSV">
          <IconDownload size={15} />
        </button>
        <button className="btn btn-primary ml-add" onClick={() => setAdding(true)}>
          <IconPlus size={14} /> Add Lead
        </button>
      </div>


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
          onOpen={(id) => navigate(`/crm/leads/${id}`)}
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
        <section className="card ml-table-card" style={{ opacity: leads.refetching ? 0.6 : 1 }}>
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
                <table className="crm-table-wide crm-leads-table">
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
                      {/* The columns this person chose in Settings; a lead's work
                          columns until they choose. */}
                      {(columns.visible as LeadColumn[]).map((col) => (
                        <th key={col.key}>{col.label} <ThCaret /></th>
                      ))}
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
                        {(columns.visible as LeadColumn[]).map((col) => (
                          <td key={col.key} className={col.className}>{col.td(lead)}</td>
                        ))}
                        <td>
                          <div className="crm-row-actions">
                            <Link
                              className="crm-icon-btn"
                              to={`/crm/leads/${lead.id}`}
                              title="Edit this lead"
                              aria-label={`Edit ${lead.name}`}
                            >
                              <IconEdit size={15} />
                            </Link>
                            <Link
                              className="crm-icon-btn"
                              to={`/crm/quotations/new?lead=${lead.id}`}
                              title="Create quotation"
                              aria-label={`Create a quotation for ${lead.name}`}
                            >
                              <IconSheet size={15} />
                            </Link>
                            <WhatsAppButton mobile={lead.whatsapp ?? lead.mobile} />
                            <button
                              className="crm-icon-btn"
                              onClick={() => setEmailing(lead)}
                              title={lead.email ? `Email ${lead.email}` : 'Email'}
                              aria-label={`Email ${lead.name}`}
                            >
                              <IconMail size={15} />
                            </button>
                            <button
                              className="crm-icon-btn crm-icon-danger"
                              onClick={() => remove(lead)}
                              title="Delete"
                              aria-label={`Delete ${lead.name}`}
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
          onSaved={(created) => {
            setAdding(false)
            setEditing(null)
            leads.reload()
            if (created) setBanner(`${created.name} saved.`)
          }}
        />
      )}

      {emailing && (
        <LeadEmailDialog
          lead={emailing}
          onClose={() => setEmailing(null)}
          onSent={(message) => {
            setEmailing(null)
            setBanner(message)
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

    </div>
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

export function LeadForm({
  lead,
  onClose,
  onSaved,
  inline,
  opportunity,
}: {
  lead: Lead | null
  onClose: () => void
  onSaved: (created?: Lead) => void
  /** Render in the page instead of a dialog. */
  inline?: boolean
  /** Editing only: the deal to edit with the lead, null when it has none yet.
   *  Left out, the deal fields are not shown. */
  opportunity?: Opportunity | null
}) {
  // What the form opened with: a reload behind it must not swap the deal under
  // what is being typed.
  const [dealRecord] = useState(opportunity)
  const showDeal = !lead || dealRecord !== undefined
  const [name, setName] = useState(lead?.name ?? '')
  const [company, setCompany] = useState(lead?.company ?? '')
  // The form holds the ten national digits; "+91" is shown beside the box and
  // added back when the lead is saved.
  const [mobile, setMobile] = useState(nationalDigits(lead?.mobile, '+91', 10))
  const [email, setEmail] = useState(lead?.email ?? '')
  // "Same as mobile" is the default because it is true nine times in ten, and
  // the server applies the same rule when the field is left empty.
  const [sameNumber, setSameNumber] = useState(
    lead ? (lead.whatsapp ?? lead.mobile) === lead.mobile : true,
  )
  const [whatsapp, setWhatsapp] = useState(nationalDigits(lead?.whatsapp, '+91', 10))
  const [sourceId, setSourceId] = useState(lead?.source_id ?? '')
  const [industryId, setIndustryId] = useState(lead?.industry_id ?? '')
  const [productId, setProductId] = useState(lead?.product_id ?? '')
  const [ownerId, setOwnerId] = useState(lead?.owner_id ?? '')
  const [statusId, setStatusId] = useState(lead?.status_id ?? '')
  // Inline, the stage can be moved from the panel beside the form. Follow it, or
  // saving the form would put the lead back on the stage it opened with.
  useEffect(() => {
    if (lead?.status_id) setStatusId(lead.status_id)
  }, [lead?.status_id])
  const [pincode, setPincode] = useState(lead?.pincode ?? '')
  const [countryId, setCountryId] = useState('')
  const [stateId, setStateId] = useState(lead?.state_id ?? '')
  const [cityId, setCityId] = useState(lead?.city_id ?? '')
  const [address, setAddress] = useState(lead?.address ?? '')
  const [value, setValue] = useState(lead?.value ?? dealRecord?.expected_revenue ?? '')
  const [openingValue] = useState(String(lead?.value ?? dealRecord?.expected_revenue ?? '').trim())
  const [deal, setDeal] = useState(() => (dealRecord ? dealFromOpportunity(dealRecord) : blankDeal()))
  // What already saved, so a retry after a failure does not create a second one.
  const savedLead = useRef<Lead | null>(null)
  const savedDeal = useRef<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const countries = useQuery('crm-countries', () => crm.masters<Country>('countries'))
  useEffect(() => {
    if (!countryId && countries.data && countries.data.length > 0) {
      setCountryId(countries.data[0].id)
    }
  }, [countries.data, countryId])

  // The country sets the dial code and how many digits a mobile has. The lead
  // form has no country picker, so it is the first one — India on a fresh
  // workspace.
  const country = countries.data?.find((c) => c.id === countryId) ?? countries.data?.[0]
  const dial = country?.dial_code || '+91'
  const length = country?.mobile_length ?? 10
  // The stored number was split with India's defaults above, before the
  // country had loaded; split it again, once, with the real ones.
  const resplit = useRef(false)
  useEffect(() => {
    if (!country || resplit.current) return
    resplit.current = true
    if (dial === '+91' && length === 10) return
    setMobile(nationalDigits(lead?.mobile, dial, length))
    setWhatsapp(nationalDigits(lead?.whatsapp, dial, length))
  }, [country, dial, length, lead])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (stepped && step < lastStep) { goNext(); return }
    setSaving(true)
    setError(null)
    const body = {
      name,
      company: company || null,
      mobile: withDialCode(dial, mobile),
      whatsapp: sameNumber ? withDialCode(dial, mobile) : whatsapp ? withDialCode(dial, whatsapp) : null,
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
      if (lead) {
        savedLead.current = await crm.patchLead(lead.id, body)
        if (showDeal && (dealRecord || dealStarted(deal))) {
          savedDeal.current = await saveDeal(lead.id, name, dealRevenue, deal, dealRecord?.id ?? savedDeal.current, dealRecord?.title)
          await uploadDealFiles(savedDeal.current, deal, dealRecord)
        }
        onSaved()
      } else {
        const { status_id: _status, ...again } = body
        const row = savedLead.current ? await crm.patchLead(savedLead.current.id, again) : await crm.createLead(body)
        savedLead.current = row
        if (dealStarted(deal)) {
          savedDeal.current = await saveDeal(row.id, row.name, String(value ?? ''), deal, savedDeal.current)
          await uploadDealFiles(savedDeal.current, deal)
        }
        onSaved(row)
      }
    } catch (err) {
      if (inline) formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      else formRef.current?.scrollTo(0, 0)
      setError(err instanceof Error && !('status' in err) ? err.message : crmError(err, savedLead.current ? 'The lead is saved, but its deal details could not be saved' : 'That lead could not be saved'))
    } finally {
      setSaving(false)
    }
  }

  // Checked as the person types, but only shown once they have left the field —
  // a red "invalid" under a number that is half typed is noise, not help.
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const touch = (key: string) => () => setTouched((t) => ({ ...t, [key]: true }))
  const mobileBad = mobile !== '' && mobile.length !== length

  /* A number can only be a lead once. Asked of the server once the number is
     complete, and answered per number so a slow reply for an earlier number can
     never clear the error on the one now in the box. A failed check does not
     block: the server refuses a duplicate on save as well. */
  const fullMobile = mobile.length === length ? withDialCode(dial, mobile) : ''
  const [dupe, setDupe] = useState<{ number: string; text: string | null } | null>(null)
  useEffect(() => {
    if (!fullMobile) return
    let live = true
    const timer = window.setTimeout(() => {
      crm.checkLeadMobile(fullMobile, lead?.id)
        .then((found) => {
          if (!live) return
          const text = found.exists
            ? `Already a lead: ${found.code}${found.name ? ` (${found.name})` : ''}${found.owner_name ? `, owned by ${found.owner_name}` : ''}. Use a different number.`
            : null
          setDupe({ number: fullMobile, text })
        })
        .catch(() => live && setDupe({ number: fullMobile, text: null }))
    }, 350)
    return () => { live = false; window.clearTimeout(timer) }
  }, [fullMobile, lead?.id])
  const mobileTaken = Boolean(fullMobile) && dupe?.number === fullMobile && dupe.text !== null
  const mobileChecking = Boolean(fullMobile) && dupe?.number !== fullMobile
  const mobileDupText = mobileTaken ? dupe?.text ?? null : null

  /* What this person has chosen to show, require or hide on the form. A lead
     being edited still needs every field it shows, as before. */
  const fields = useFieldModes('lead-form', LEAD_FIELDS)
  const fm = fields.mode
  const rq = (key: string) => Boolean(lead) || fm(key) === 'mandatory'
  const emptyField: Record<string, boolean> = {
    company: company.trim() === '', email: email.trim() === '', whatsapp: !sameNumber && whatsapp === '',
    source: !sourceId, owner: !ownerId, industry: !industryId, item: !productId,
    state: !stateId, city: !cityId, pincode: pincode.trim() === '', address: address.trim() === '',
  }
  /* A mandatory field left empty, among the ones on this step. */
  const missingIn = (keys: string[]) => keys.some((k) => fm(k) === 'mandatory' && emptyField[k])
  const missingCustomer = missingIn(['company', 'email', 'whatsapp'])
  const missingLead = missingIn(['source', 'owner', 'industry', 'item'])
  const missingAddress = missingIn(['state', 'city', 'pincode', 'address'])
  const whatsappBad = !sameNumber && whatsapp !== '' && whatsapp.length !== length
  const emailBad = email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  const pincodeBad = pincode.trim() !== '' && !/^\d{6}$/.test(pincode.trim())
  const valueText = String(value ?? '').trim()
  const valueBad = valueText !== '' && !/^\d{1,9}(\.\d{1,2})?$/.test(valueText)
  const revenue = valueBad ? 0 : Number(valueText || 0)
  // A saved deal keeps its own value unless Expected revenue is changed here: the
  // two can differ, and editing a phone number must not rewrite the deal.
  const dealRevenue = dealRecord && valueText === openingValue ? String(dealRecord.expected_revenue) : valueText
  const needsRevenue = showDeal && (Boolean(dealRecord) || dealStarted(deal)) && dealRevenue === ''
  // Editing a lead: every field must have a value.
  // A field this person has hidden is not one they are asked to fill in.
  const dealMand = showDeal ? dealMandatoryMissing(deal, fm, dealRecord) : { deal: false, opportunity: false }
  const valueMissing = fm('value') === 'mandatory' && valueText === ''
  const editMissing = Boolean(lead) && (
    ['company', 'email', 'whatsapp', 'source', 'owner', 'industry', 'item', 'state', 'city', 'pincode', 'address']
      .some((k) => fm(k) !== 'hide' && emptyField[k])
    || !statusId || (fm('value') !== 'hide' && valueText === '') || (showDeal && dealIncomplete(deal, dealRecord, fm))
  )
  const ready = !editMissing && !missingCustomer && !missingLead && !missingAddress && name.trim() !== '' && mobile.trim() !== '' && !mobileBad && !mobileTaken && !mobileChecking && !whatsappBad && !emailBad && !pincodeBad && !valueBad && !dealMand.deal && !dealMand.opportunity && !valueMissing
    && (!showDeal || (!dealBlocked(deal, fm('value') === 'hide' ? 'x' : dealRevenue, Boolean(dealRecord)) && !dealFilesTooBig(deal)))

  const formRef = useRef<HTMLFormElement>(null)
  // A new lead in the popup is filled in over steps; editing, and the inline
  // form on the lead page, stay on one page.
  const stepped = !lead && !inline
  const [step, setStep] = useState(0)
  const dealOk = !showDeal || (!dealBlocked(deal, fm('value') === 'hide' ? 'x' : dealRevenue, Boolean(dealRecord)) && !dealFilesTooBig(deal))
  // Expected revenue is entered on the next step, so the deal step must not wait for it.
  const dealStepOk = !showDeal || (!dealBlocked(deal, 'x', Boolean(dealRecord)) && !dealFilesTooBig(deal))
  const stepOk = [
    name.trim() !== '' && mobile.trim() !== '' && !mobileBad && !mobileTaken && !mobileChecking && !whatsappBad && !emailBad && !missingCustomer,
    !missingLead,
    !pincodeBad && !missingAddress,
    dealStepOk && !dealMand.deal,
    dealOk && !valueBad && !dealMand.opportunity && !valueMissing,
  ]
  const lastStep = showDeal ? 4 : 2
  const stepNames = ['Customer info', 'Lead info', 'Address', ...(showDeal ? ['Deal details', 'Opportunity'] : [])]
  const goNext = () => {
    if (!stepOk[step]) {
      setTouched((t) => ({ ...t, mobile: true, email: true, whatsapp: true, pincode: true, value: true }))
      return
    }
    setStep((n) => Math.min(n + 1, lastStep))
    formRef.current?.scrollTo(0, 0)
  }
  // What is stopping Save, said where the Save button is.
  const customerBad = mobileBad || whatsappBad || emailBad
  const blocker = ready ? null
    : name.trim() === '' || mobile === '' ? 'Add the full name and mobile number'
      : mobileTaken ? 'This mobile number is already a lead'
        : mobileChecking ? 'Checking the mobile number…'
      : customerBad ? 'Check the contact details'
        : missingCustomer || missingLead || missingAddress ? <>Fill in the fields marked <b className="lf-req">*</b></>
        : pincodeBad ? 'Check the address'
          : valueBad ? 'Check the expected revenue'
          : needsRevenue ? 'Add the expected revenue for the deal'
            : editMissing ? 'Every field is required — fill in the empty ones'
              : 'Complete the deal details'

  /* Expected revenue sits with the opportunity it describes. A lead edited
     without an opportunity has no such section, so it stays with the address. */
  const revenueField = (
    <LfField label="Expected revenue"
             required={needsRevenue || Boolean(lead) || fm('value') === 'mandatory'}
             error={touched.value && valueBad ? 'Enter an amount like 150000 or 150000.50.' : needsRevenue ? 'Needed once deal details are filled in.' : undefined}
             hint={revenue > 0 ? `₹${revenue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : 'Optional — leave it blank rather than guessing.'}>
      <LfInput prefix="₹" bad={touched.value && valueBad}>
        <input value={value ?? ''} onChange={(event) => setValue(event.target.value.replace(/,/g, ''))} onBlur={touch('value')}
               type="number" data-spin min={0} step="any" placeholder="e.g. 150000" aria-label="Expected revenue" />
      </LfInput>
    </LfField>
  )

  const stepBlocker = !stepOk[step]
    ? step === 0 ? (name.trim() === '' || mobile === '' ? 'Add the full name and mobile number' : mobileTaken ? 'This mobile number is already a lead' : mobileChecking ? 'Checking the mobile number…' : missingCustomer ? <>Fill in the fields marked <b className="lf-req">*</b></> : 'Check the contact details')
      : step === 1 ? <>Fill in the fields marked <b className="lf-req">*</b></>
      : step === 2 ? (missingAddress ? <>Fill in the fields marked <b className="lf-req">*</b></> : 'Check the address') : step === 3 ? 'Complete the deal details' : valueBad ? 'Check the expected revenue' : 'Complete the opportunity details'
    : null
  const footer = stepped ? (
    <>
      {stepBlocker
        ? <span className="lf-foot-note lf-foot-link">{stepBlocker}</span>
        : <span className="lf-foot-note"><span className="lf-req">*</span> Required fields</span>}
      {step === 0
        ? <button className="btn" onClick={onClose} type="button">Cancel</button>
        : <button className="btn" onClick={() => setStep((n) => n - 1)} type="button">Back</button>}
      {step < lastStep ? (
        <button key="next" className="btn btn-primary lf-save" type="button" onClick={goNext} disabled={!stepOk[step]}>
          Next
        </button>
      ) : (
        <button key="save" className="btn btn-primary lf-save" form="crm-lead-form" type="submit" disabled={saving || !ready}>
          <IconCheck size={15} /> {saving ? 'Saving…' : 'Save lead'}
        </button>
      )}
    </>
  ) : (
    <>
      {blocker
        ? <span className="lf-foot-note lf-foot-link">{blocker}</span>
        : <span className="lf-foot-note"><span className="lf-req">*</span> Required fields</span>}
      <button className="btn" onClick={onClose} type="button">
        Cancel
      </button>
      <button
        className="btn btn-primary lf-save"
        form="crm-lead-form"
        type="submit"
        disabled={saving || !ready}
      >
        <IconCheck size={15} /> {saving ? 'Saving…' : lead ? 'Save changes' : 'Save lead'}
      </button>
    </>
  )

  /* Every field of the form as an element, so the order a person arranged in
     Settings can place them. A hidden field is nothing at all. */
  const fieldNodes: Record<string, ReactNode> = {
    name: (
<LfField label="Full name" required>
            <LfInput icon={<IconUser size={15} />}>
              <input value={name} onChange={(event) => setName(event.target.value)}
                     placeholder="e.g. Rahul Sharma" autoFocus required />
            </LfInput>
          </LfField>
          ),
    company: fm('company') !== 'hide' && (
          <LfField label="Company" required={rq('company')}>
            <LfInput icon={<IconBriefcase size={15} />}>
              <input value={company} onChange={(event) => setCompany(event.target.value)}
                     placeholder="Company / firm name" />
            </LfInput>
          </LfField>
          ),
    mobile: (
<LfField label="Mobile number" required
                   error={touched.mobile && mobileBad ? `Enter a ${length}-digit mobile number.` : mobileDupText ?? undefined}>
            <LfInput icon={<IconPhone size={15} />} prefix={dial} bad={(touched.mobile && mobileBad) || mobileTaken}>
              <input value={mobile} onChange={(event) => setMobile(onlyDigits(event.target.value, length))} onBlur={touch('mobile')}
                     placeholder={'9876543210'.slice(0, length)} inputMode="numeric" maxLength={length} required />
            </LfInput>
          </LfField>
          ),
    email: fm('email') !== 'hide' && (
          <LfField label="Email" required={rq('email')} error={touched.email && emailBad ? 'That does not look like an email address.' : undefined}>
            <LfInput icon={<IconMail size={15} />} bad={touched.email && emailBad}>
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} onBlur={touch('email')}
                     placeholder="name@company.com" />
            </LfInput>
          </LfField>
          ),
    whatsapp: fm('whatsapp') !== 'hide' && (
          <LfField label="WhatsApp" required={rq('whatsapp') && !sameNumber}
                   error={touched.whatsapp && whatsappBad ? `Enter a ${length}-digit WhatsApp number.` : undefined}
                   aside={
                     <label className="lf-switch">
                       <input type="checkbox" checked={sameNumber}
                              onChange={(event) => setSameNumber(event.target.checked)} />
                       <span className="lf-switch-track" aria-hidden><span /></span>
                       Same as mobile
                     </label>
                   }>
            <LfInput icon={<IconPhone size={15} />} prefix={dial} bad={touched.whatsapp && whatsappBad}>
              <input value={sameNumber ? mobile : whatsapp} onChange={(event) => setWhatsapp(onlyDigits(event.target.value, length))}
                     onBlur={touch('whatsapp')} disabled={sameNumber} inputMode="numeric" maxLength={length}
                     placeholder={sameNumber ? 'Uses the mobile number' : 'WhatsApp number'} />
            </LfInput>
          </LfField>
          ),
    source: fm('source') !== 'hide' && (
          <LfField label="Lead source" required={rq('source')}>
            <MasterSelect kind="sources" value={sourceId} onChange={setSourceId} placeholder="Select source" />
          </LfField>
          ),
    owner: fm('owner') !== 'hide' && (
          <LfField label="Lead owner" required={rq('owner')}>
            <OwnerSelect value={ownerId} onChange={setOwnerId} />
          </LfField>
          ),
    industry: fm('industry') !== 'hide' && (
          <LfField label="Industry type" required={rq('industry')}>
            <MasterSelect kind="industries" value={industryId} onChange={setIndustryId} placeholder="Select industry" />
          </LfField>
          ),
    item: fm('item') !== 'hide' && (
          <LfField label="Item" required={rq('item')}>
            <ItemSelect value={productId} onChange={setProductId} placeholder="Select item" />
          </LfField>
          ),
    state: fm('state') !== 'hide' && (
          <LfField label="State" required={rq('state')}>
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
              placeholder="Select state"
            />
          </LfField>
          ),
    city: fm('city') !== 'hide' && (
          <LfField label="City" required={rq('city')} hint={stateId ? undefined : 'Pick a state first.'}>
            <MasterSelect kind="cities" value={cityId} onChange={setCityId} parentId={stateId}
                          placeholder="Select city" />
          </LfField>
          ),
    pincode: fm('pincode') !== 'hide' && (
          <LfField label="Pincode" required={rq('pincode')} error={touched.pincode && pincodeBad ? 'A pincode is 6 digits.' : undefined}>
            <LfInput icon={<IconPin size={15} />} bad={touched.pincode && pincodeBad}>
              <input value={pincode} onChange={(event) => setPincode(event.target.value)} onBlur={touch('pincode')}
                     placeholder="6-digit pincode" inputMode="numeric" maxLength={6} />
            </LfInput>
          </LfField>
          ),
    address: fm('address') !== 'hide' && (
          <LfField label="Address" required={rq('address')}>
            <textarea value={address} onChange={(event) => setAddress(event.target.value)} rows={2}
                      placeholder="Building, street, area, landmark" />
          </LfField>
          ),
  }
  const fieldsOf = (section: string) =>
    fields.orderOf(section).map((key) => <Fragment key={key}>{fieldNodes[key]}</Fragment>)

  const form = (
      <form className="lf lf-single" id="crm-lead-form" ref={formRef} onSubmit={submit} noValidate>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="lf-settings">
          <FieldSettings defs={LEAD_FIELDS} sections={LEAD_SECTIONS} modes={fields.modes} order={fields.order}
                         onSave={fields.save} onReset={fields.reset} />
        </div>
        {stepped && (
          <ol className="lf-steps" aria-label="Lead steps">
            {stepNames.map((label, i) => (
              <li key={label} className={i === step ? 'is-current' : i < step ? 'is-done' : ''}
                  aria-current={i === step ? 'step' : undefined}>
                <button type="button" disabled={i > step && !stepOk.slice(0, i).every(Boolean)}
                        onClick={() => setStep(i)}>
                  <span className="lf-step-dot">{i < step ? <IconCheck size={12} /> : i + 1}</span>
                  <span className="lf-step-label">{label}</span>
                </button>
              </li>
            ))}
          </ol>
        )}

        {(!stepped || step === 0) && <LfSection icon={<IconUser size={16} />} title="Customer info" note="The person you will be speaking to.">
          {fieldsOf('customer')}
          
          

          
          

          
        </LfSection>}

        {(!stepped || step === 1) && <LfSection icon={<IconStar size={16} />} title="Lead info" note="Where it came from, what they want, and who owns it.">
          {fieldsOf('lead')}
          
          
          
          
          {lead && (
            <LfField label="Stage" required={Boolean(lead)}>
              <MasterSelect kind="statuses" value={statusId} onChange={setStatusId} placeholder="Select stage" />
            </LfField>
          )}
        </LfSection>}

        {(!stepped || step === 2) && <LfSection icon={<IconPin size={16} />} title="Address" note="Where they are.">
          {fieldsOf('address')}
          {!showDeal && fm('value') !== 'hide' && revenueField}
          
          
          
          
        </LfSection>}

        {showDeal && (!stepped || step >= 3) && (
          <LeadDealFields deal={deal} onChange={setDeal} revenue={valueBad ? '' : dealRevenue} saved={dealRecord} leading={fm('value') === 'hide' ? null : revenueField} fm={fm}
                          part={stepped ? (step === 3 ? 'deal' : 'opportunity') : 'both'} all={Boolean(lead)} />
        )}
      </form>
  )

  if (inline) {
    return (
      <div className="lf-inline">
        {form}
        <div className="lf-inline-foot">{footer}</div>
      </div>
    )
  }

  return (
    <Dialog
      title={lead ? `Edit ${lead.name}` : 'Add new lead'}
      subtitle={lead
        ? <>Lead <span className="crm-code">#{lead.code}</span> — change anything and save.</>
        : 'Fill in the steps. Only the name and mobile number are required.'}
      onClose={onClose}
      footer={footer}
    >
      {form}
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
export function splitCsvLine(line: string): string[] {
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
          <textarea placeholder="e.g. Interested in the annual plan" value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} />
        </Field>
      </div>
    </Dialog>
  )
}

export function ConvertDialog({
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
  const [startOn, setStartOn] = useState(todayISO())
  const [amount, setAmount] = useState('')
  const [amountTyped, setAmountTyped] = useState(false)
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
          <input placeholder="e.g. CUST-0001" value={code} onChange={(event) => setCode(event.target.value)} />
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
            <Field label="Item">
              <ItemSelect
                value={productId}
                onChange={setProductId}
                onPick={(item) => {
                  if (!amountTyped) setAmount(item ? item.sale_price : '')
                }}
              />
            </Field>
            <Field label="Starts on">
              <input type="date" value={startOn} onChange={(event) => setStartOn(event.target.value)} />
            </Field>
            <Field label="Amount">
              <input
                value={amount}
                onChange={(event) => { setAmount(event.target.value); setAmountTyped(event.target.value !== '') }}
                type="number" data-spin min={0} step="any"
                placeholder="0.00"
              />
            </Field>
          </>
        )}
      </div>
    </Dialog>
  )
}


/* ------------------------------------------------------------ created range --- */

const RANGE_PRESETS: Array<{ label: string; range: () => [string, string] }> = [
  { label: 'Today', range: () => [todayISO(), todayISO()] },
  { label: 'Last 7 days', range: () => [daysFromTodayISO(-6), todayISO()] },
  { label: 'Last 30 days', range: () => [daysFromTodayISO(-29), todayISO()] },
  { label: 'Last 90 days', range: () => [daysFromTodayISO(-90), todayISO()] },
  {
    label: 'This month',
    range: () => {
      const d = new Date()
      return [new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString('en-CA'), todayISO()]
    },
  },
  { label: 'This year', range: () => [`${new Date().getFullYear()}-01-01`, todayISO()] },
]

function rangeLabel(from: string, to: string): string {
  const f = new Date(from + 'T00:00:00')
  const t = new Date(to + 'T00:00:00')
  const day = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
  if (from === to) return `${day(f)} ${f.getFullYear()}`
  return f.getFullYear() === t.getFullYear()
    ? `${day(f)} – ${day(t)} ${t.getFullYear()}`
    : `${day(f)} ${f.getFullYear()} – ${day(t)} ${t.getFullYear()}`
}

/** The lead "created" window as one control: a button showing the range, and
 *  a small panel of presets plus a custom from–to. */
function CreatedRange({
  from, to, onChange,
}: {
  from: string
  to: string
  onChange: (from: string, to: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [draftFrom, setDraftFrom] = useState(from)
  const [draftTo, setDraftTo] = useState(to)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setDraftFrom(from)
    setDraftTo(to)
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, from, to])

  const pick = (f: string, t: string) => { onChange(f, t); setOpen(false) }

  return (
    <div className="ml-range" ref={ref}>
      <button type="button" className={`ml-range-btn${open ? ' is-open' : ''}`}
              onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog"
              title="Created date">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
             strokeLinecap="round" aria-hidden="true">
          <rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" />
        </svg>
        <span>{from && to ? rangeLabel(from, to) : rangeLabel(todayISO(), todayISO())}</span>
        <svg className="ml-range-caret" width="14" height="14" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="ml-range-pop" role="dialog" aria-label="Created date">
          <div className="ml-range-presets">
            {RANGE_PRESETS.map((p) => {
              const [f, t] = p.range()
              const on = f === from && t === to
              return (
                <button key={p.label} type="button" className={on ? 'is-on' : ''} onClick={() => pick(f, t)}>
                  {p.label}
                </button>
              )
            })}
          </div>
          <div className="ml-range-custom">
            <span className="ml-range-title">Custom range</span>
            <div className="ml-range-inputs">
              <input type="date" value={draftFrom} max={draftTo || undefined} aria-label="Created from"
                     onChange={(e) => setDraftFrom(e.target.value)} />
              <span aria-hidden="true">–</span>
              <input type="date" value={draftTo} min={draftFrom || undefined} aria-label="Created to"
                     onChange={(e) => setDraftTo(e.target.value)} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <button type="button" className="btn btn-sm" disabled={!from && !to}
                      onClick={() => pick('', '')}>
                Clear
              </button>
              <button type="button" className="btn btn-primary btn-sm"
                      disabled={!draftFrom || !draftTo || draftFrom > draftTo}
                      onClick={() => pick(draftFrom, draftTo)}>
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
