/* ERP → Account → Voucher Entry → Receipt / Payment.

   Laid out like the Ledger master: a toolbar card, a table card with row actions, and detail cards for the
   selected voucher. Create opens a popup with GENERAL INFO and POSTINGS sections. A voucher will not save until
   its debits and credits balance. A receipt credits the party and debits the cash or bank the money landed in; a
   payment is the reverse. The lines are free, so the same form records an expense, a transfer or an adjustment. */

import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import '../../styles/erp-voucher.css'
import { useQuery } from '../../lib/useQuery'
import { todayISO } from '../../lib/format'
import { downloadCsv } from '../../lib/sheet'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconDownload, IconPlus, IconSearch, IconTrash } from '../../components/Icons'
import FilterPopup, { FilterField } from '../../components/FilterPopup'
import { CrmPage } from '../crm/parts'
import { DateText, Dialog, ReasonDialog, SearchSelect, useAccess, useRun } from './parts'
import { erp, rupees, type Ledger, type Voucher, type VoucherType } from './api'

const TITLE: Record<VoucherType, { noun: string; base: string }> = {
  receipt: { noun: 'Receipt', base: '/erp/receipt-voucher' },
  payment: { noun: 'Payment', base: '/erp/payment-voucher' },
}

const monthStart = () => `${todayISO().slice(0, 8)}01`
const money = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const sideText = (side: string) => (side === 'cr' ? 'Cr' : 'Dr')

/* ------------------------------------------------------------------- book --- */

export function VoucherBook({ type, startNew }: { type: VoucherType; startNew?: boolean }) {
  const t = TITLE[type]
  const navigate = useNavigate()
  const { can } = useAccess()
  const manage = can('can_manage_billing')
  const [start, setStart] = useState(monthStart)
  const [end, setEnd] = useState(todayISO)
  const [q, setQ] = useState('')
  const list = useQuery(`vouchers-${type}-${start}-${end}`, () => erp.vouchers(type, { start, end }))
  const [picked, setPicked] = useState<string | null>(null)
  const [creating, setCreating] = useState(Boolean(startNew))
  const [cancelling, setCancelling] = useState<Voucher | null>(null)
  const act = useRun(() => list.reload())

  const needle = q.trim().toLowerCase()
  const rows = useMemo(
    () => (list.data ?? []).filter((r) => !needle || [r.number, r.party, r.narration].some((v) => v && v.toLowerCase().includes(needle))),
    [list.data, needle],
  )
  const current = rows.find((r) => r.id === picked) ?? rows[0] ?? null
  const posted = rows.filter((r) => r.status === 'posted')
  const debit = posted.reduce((n, r) => n + Number(r.debit), 0)
  const credit = posted.reduce((n, r) => n + Number(r.credit), 0)
  const filtered = start !== monthStart() || end !== todayISO() ? 1 : 0

  function closeNew() {
    setCreating(false)
    if (startNew) navigate(t.base, { replace: true })
  }

  function exportRows() {
    downloadCsv(`${type}-book-${start}-to-${end}.csv`, ['Date', 'Number', 'Party', 'Remark', 'Debit', 'Credit', 'Status'],
      rows.map((r) => [r.voucher_date, r.number, r.party, r.narration ?? '', r.debit, r.credit, r.status]))
  }

  return (
    <CrmPage>
      <div className="vc">
        <div className="vc-bar">
          <label className="vc-search">
            <IconSearch size={15} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search number, party, remark" aria-label={`Search ${type}s`} />
          </label>
          <FilterPopup count={filtered} onReset={() => { setStart(monthStart()); setEnd(todayISO()) }}>
            <FilterField label="From"><input type="date" value={start} max={end} onChange={(e) => setStart(e.target.value)} /></FilterField>
            <FilterField label="To"><input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} /></FilterField>
          </FilterPopup>
          <span className="vc-total">Total no. of {type}s: {rows.length}</span>
          <div className="vc-tools">
            <button type="button" className="vc-icon-btn" title="Export" aria-label="Export" disabled={rows.length === 0} onClick={exportRows}><IconDownload size={16} /></button>
            {manage && (
              <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><IconPlus size={15} /> Create</button>
            )}
          </div>
        </div>

        {list.loading && !list.data && <Loading />}
        {list.error && <ErrorNote>{list.error}</ErrorNote>}
        {act.error && <ErrorNote>{act.error}</ErrorNote>}

        {!list.loading && !list.error && (
          <>
            <section className="card vc-card">
              {rows.length === 0 ? (
                <EmptyState title={`No ${type}s in this period`} body={manage ? 'Choose Create to record one.' : 'Nothing has been recorded yet.'} />
              ) : (
                <div className="table-wrap">
                  <table className="table vc-table">
                    <thead>
                      <tr>
                        <th>Date</th><th>Number</th><th>Party name</th><th>Remark</th>
                        <th className="num">Debit</th><th className="num">Credit</th><th className="num">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id} className={`${current?.id === r.id ? 'is-on' : ''}${r.status === 'cancelled' ? ' is-void' : ''}`}
                            onClick={() => setPicked(r.id)}>
                          <td><DateText iso={r.voucher_date} /></td>
                          <td className="vc-num">{r.number}{r.status === 'cancelled' && <span className="vc-tag">Cancelled</span>}</td>
                          <td><b>{r.party}</b></td>
                          <td className="vc-remark">{r.narration ?? '—'}</td>
                          <td className="num">{Number(r.debit) ? money(Number(r.debit)) : ''}</td>
                          <td className="num">{Number(r.credit) ? money(Number(r.credit)) : ''}</td>
                          <td className="num">
                            {r.status === 'posted' && manage && (
                              <button type="button" className="vc-icon-btn" title="Cancel voucher" aria-label={`Cancel ${r.number}`}
                                      onClick={(e) => { e.stopPropagation(); setCancelling(r) }}><IconTrash size={14} /></button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <footer className="vc-foot">
                <span>{rows.length} voucher{rows.length === 1 ? '' : 's'}</span>
                <span className="vc-foot-total">Voucher total <b>{money(debit)}</b> <b>{money(credit)}</b></span>
              </footer>
            </section>

            <div className="vc-cards">
              <section className="card vc-info">
                <h2>{t.noun} details</h2>
                <dl>
                  <dt>Number</dt><dd>{current?.number ?? '—'}</dd>
                  <dt>Date</dt><dd>{current ? <DateText iso={current.voucher_date} /> : '—'}</dd>
                  <dt>Party</dt><dd>{current?.party ?? '—'}</dd>
                  <dt>Amount</dt><dd>{current ? `${rupees(current.amount)} ${sideText(type === 'receipt' ? 'cr' : 'dr')}` : '—'}</dd>
                </dl>
              </section>
              <section className="card vc-info">
                <h2>Ledger postings</h2>
                {current ? (
                  <table className="vc-post">
                    <thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
                    <tbody>
                      {current.postings.map((p, i) => (
                        <tr key={i}>
                          <td>{p.ledger}{p.station && <small>{p.station}</small>}</td>
                          <td className="num">{Number(p.debit) ? money(Number(p.debit)) : ''}</td>
                          <td className="num">{Number(p.credit) ? money(Number(p.credit)) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <p className="vc-none">—</p>}
              </section>
              <section className="card vc-info">
                <h2>Entry &amp; narration</h2>
                <dl>
                  <dt>Entered by</dt><dd>{current?.entered_by ?? '—'}</dd>
                  <dt>Entered at</dt>
                  <dd>{current?.entered_at ? new Date(current.entered_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—'}</dd>
                  <dt>Status</dt><dd>{current ? (current.status === 'posted' ? 'Posted' : 'Cancelled') : '—'}</dd>
                  <dt>Narration</dt><dd className="vc-wrap">{current?.narration ?? '—'}</dd>
                </dl>
                {current?.status === 'cancelled' && <p className="vc-void-note">Cancelled: {current.cancel_reason}</p>}
              </section>
            </div>
          </>
        )}
      </div>

      {creating && <VoucherDialog type={type} onClose={closeNew} onSaved={() => { closeNew(); list.reload() }} />}
      {cancelling && (
        <ReasonDialog
          title={`Cancel ${cancelling.number}`}
          hint="The voucher stays in the book, marked cancelled, and stops posting to the ledgers."
          confirm="Cancel voucher" danger
          onClose={() => setCancelling(null)}
          onSubmit={async (reason) => { await act.run(() => erp.cancelVoucher(cancelling.id, reason)); setCancelling(null) }}
        />
      )}
    </CrmPage>
  )
}

/* ----------------------------------------------------------------- dialog --- */

interface Line { entry: 'dr' | 'cr'; ledger: string; amount: string; narration: string }

const blank = (entry: 'dr' | 'cr'): Line => ({ entry, ledger: '', amount: '', narration: '' })

function VoucherDialog({ type, onClose, onSaved }: { type: VoucherType; onClose: () => void; onSaved: () => void }) {
  const t = TITLE[type]
  const [date, setDate] = useState(todayISO)
  const [lines, setLines] = useState<Line[]>(type === 'receipt' ? [blank('cr'), blank('dr')] : [blank('dr'), blank('cr')])
  const [narration, setNarration] = useState('')
  const [focus, setFocus] = useState(0)
  const [balances, setBalances] = useState<Record<string, string>>({})
  const ledgers = useQuery<Ledger[]>('voucher-ledgers', () => erp.ledgers({}))
  const number = useQuery(`voucher-number-${type}-${date}`, () => erp.voucherNumber(type, date))
  const save = useRun()

  const options = useMemo(
    () => (ledgers.data ?? []).filter((l) => l.is_active).map((l) => ({ value: l.id, label: l.name, hint: l.account_group })),
    [ledgers.data],
  )
  const byId = useMemo(() => new Map((ledgers.data ?? []).map((l) => [l.id, l])), [ledgers.data])

  const set = (at: number, patch: Partial<Line>) => setLines((rows) => rows.map((r, i) => (i === at ? { ...r, ...patch } : r)))

  async function choose(at: number, ledger: string) {
    set(at, { ledger })
    setFocus(at)
    if (ledger && balances[ledger] === undefined) {
      try {
        const b = await erp.ledgerBalance(ledger)
        setBalances((m) => ({ ...m, [ledger]: `${rupees(b.balance)} ${sideText(b.side)}` }))
      } catch {
        setBalances((m) => ({ ...m, [ledger]: '—' }))
      }
    }
  }

  /* On a two-line voucher the other line takes the same amount, so the common case is two picks and one number. */
  function amountChanged(at: number, value: string) {
    setLines((rows) => rows.map((r, i) => (i === at || rows.length === 2 ? { ...r, amount: value } : r)))
  }

  const totals = lines.reduce(
    (n, l) => ({ dr: n.dr + (l.entry === 'dr' ? Number(l.amount || 0) : 0), cr: n.cr + (l.entry === 'cr' ? Number(l.amount || 0) : 0) }),
    { dr: 0, cr: 0 },
  )
  const filled = lines.filter((l) => l.ledger && Number(l.amount) > 0)
  const balanced = totals.dr > 0 && Math.abs(totals.dr - totals.cr) < 0.005
  const complete = balanced && filled.length === lines.length
  const day = new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long' })
  const focused = lines[focus]?.ledger ? byId.get(lines[focus].ledger) : undefined

  async function submit() {
    const saved = await save.run(() => erp.createVoucher(type, {
      voucher_date: date,
      narration: narration.trim() || null,
      lines: lines.map((l) => ({ ledger_id: l.ledger, entry: l.entry, amount: Number(l.amount).toFixed(2), narration: l.narration.trim() || null })),
    }), `That ${type} could not be saved`)
    if (saved) onSaved()
  }

  return (
    <Dialog
      wide
      title={`Create ${type}`}
      subtitle={type === 'receipt' ? 'Money in: credit the party (or income) and debit the cash or bank it landed in.' : 'Money out: debit the party (or expense) and credit the cash or bank it left.'}
      onClose={onClose}
      footer={
        <>
          {save.error && <span className="error">{save.error}</span>}
          {!save.error && !complete && <span className="lf-foot-note lf-foot-link">Pick a ledger and an amount on every line, and balance debit with credit</span>}
          <button className="btn crm-push" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!complete || save.busy} onClick={submit}>{save.busy ? 'Saving…' : 'Save'}</button>
        </>
      }
    >
      {ledgers.loading ? <Loading /> : ledgers.error ? <ErrorNote>{ledgers.error}</ErrorNote> : (
        <div className="vc-form">
          <div className="vc-cols">
            <section>
              <h3 className="vc-sec">General info</h3>
              <div className="vc-grid2">
                <div className="vc-field"><span>Type</span><b className="vc-type">{t.noun}</b></div>
                <div className="vc-field"><span>Voucher no.</span><b>{number.data?.number ?? '…'}</b></div>
                <label className="vc-field"><span>Date <i>*</i></span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
                <div className="vc-field"><span>Day</span><b>{day}</b></div>
              </div>
              <label className="vc-field vc-wide">
                <span>Narration</span>
                <textarea rows={3} value={narration} onChange={(e) => setNarration(e.target.value)} maxLength={1000} placeholder={`What this ${type} is for`} />
              </label>
            </section>
            <section>
              <h3 className="vc-sec">Totals</h3>
              <div className="vc-totals">
                <div><span>Debit</span><b>{money(totals.dr)}</b></div>
                <div><span>Credit</span><b>{money(totals.cr)}</b></div>
                <p className={balanced ? 'is-ok' : 'is-off'}>
                  {totals.dr === 0 && totals.cr === 0 ? 'Enter an amount' : balanced ? 'Balanced' : `Difference ${money(Math.abs(totals.dr - totals.cr))}`}
                </p>
              </div>
              <p className="vc-ledger-note">
                {focused
                  ? <><b>{focused.name}</b><br />{focused.account_group}{focused.station ? ` · ${focused.station}` : ''}<br />Balance {balances[focused.id] ?? '…'}</>
                  : 'Move to a line to see its ledger.'}
              </p>
            </section>
          </div>

          <h3 className="vc-sec">Postings</h3>
          <div className="table-wrap">
            <table className="table vc-lines">
              <thead>
                <tr><th>Dr / Cr</th><th>Particulars <i>*</i></th><th className="num">Balance</th><th className="num">Debit</th><th className="num">Credit</th><th>Short narration</th><th /></tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className={focus === i ? 'is-on' : ''} onFocus={() => setFocus(i)}>
                    <td>
                      <select value={l.entry} onChange={(e) => set(i, { entry: e.target.value as 'dr' | 'cr' })} aria-label="Debit or credit">
                        <option value="dr">Dr</option><option value="cr">Cr</option>
                      </select>
                    </td>
                    <td className="vc-pick">
                      <SearchSelect value={l.ledger} onChange={(v) => void choose(i, v)} options={options} placeholder="Select ledger…" empty="No ledger found" />
                    </td>
                    <td className="num vc-bal">{l.ledger ? balances[l.ledger] ?? '…' : ''}</td>
                    <td className="num">
                      <input inputMode="decimal" disabled={l.entry !== 'dr'} value={l.entry === 'dr' ? l.amount : ''} placeholder={l.entry === 'dr' ? '0.00' : ''}
                             onChange={(e) => amountChanged(i, e.target.value.replace(/[^0-9.]/g, ''))} aria-label="Debit amount" />
                    </td>
                    <td className="num">
                      <input inputMode="decimal" disabled={l.entry !== 'cr'} value={l.entry === 'cr' ? l.amount : ''} placeholder={l.entry === 'cr' ? '0.00' : ''}
                             onChange={(e) => amountChanged(i, e.target.value.replace(/[^0-9.]/g, ''))} aria-label="Credit amount" />
                    </td>
                    <td><input value={l.narration} maxLength={200} onChange={(e) => set(i, { narration: e.target.value })} aria-label="Short narration" /></td>
                    <td>
                      {lines.length > 2 && (
                        <button className="vc-icon-btn" title="Delete line" onClick={() => setLines((rows) => rows.filter((_, j) => j !== i))}><IconTrash size={14} /></button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn vc-add" onClick={() => setLines((rows) => [...rows, blank(totals.dr > totals.cr ? 'cr' : 'dr')])}><IconPlus size={14} /> Add line</button>
        </div>
      )}
    </Dialog>
  )
}

/* The entry used to be a full page; its routes now open the book with the popup up. */
export function VoucherEntry({ type }: { type: VoucherType }) {
  return <VoucherBook type={type} startNew />
}
