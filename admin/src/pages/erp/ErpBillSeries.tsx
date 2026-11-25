/* Master -> Inventory Masters -> Bill Series: number a transaction from more than one series — Retail and
 * Wholesale, counter and online. The bill asks which one when there is a choice.
 *
 * The page keeps the numbering rules and shows the next number each series would hand out. Documents do not
 * draw their numbers from these series yet. */

import { useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '../../lib/useQuery'
import { ErrorNote, Loading } from '../../components/ui'
import { IconEdit, IconPlus, IconTrash } from '../../components/Icons'
import { FieldSettings, useFieldModes, type FieldDef, type FieldSection } from '../../components/ViewSettings'
import { Dialog, Field, useAccess, useRun } from './parts'
import { api } from '../../lib/api'
import type { User } from '../../lib/types'
import { erp, type BillSeries, type BillSeriesData, type Ledger } from './api'

const GROUP_TONE: Record<string, { label: string; dot: string }> = {
  sales: { label: 'Sales', dot: '#12a07f' }, purchase: { label: 'Purchase', dot: '#e07a1f' }, others: { label: 'Others', dot: '#7c4dff' },
}
const RESTART: Array<[BillSeries['restart'], (fy: string, cy: string) => string]> = [
  ['april', (fy) => `Every April (adds ${fy}/)`], ['never', () => 'Never'],
]
const BILLING: Array<[BillSeries['billing_type'], string]> = [['company', 'Company Default'], ['retail', 'Retail'], ['wholesale', 'Wholesale']]
const PAPERS: Array<[string, string]> = [
  ['saved', 'Saved paper'], ['a4_portrait', 'A4 — Portrait · 210 × 297 mm'], ['a4_landscape', 'A4 Landscape — Wide · 297 × 210 mm'],
  ['a5_portrait', 'A5 — Portrait · 148 × 210 mm'], ['half_page', 'Half Page — Half of A4 · 210 × 148 mm'],
  ['thermal_3', 'Thermal 3" — Roll · 80 mm wide'], ['thermal_2', 'Thermal 2" — Roll · 58 mm wide'],
]
const LAYOUTS = ['Saved layout', 'Standard', 'Classic', 'Modern', 'Executive Dark', 'Compact']

/** The financial year the numbers are being issued in: 2026-27 from April 2026. */
function years(on = new Date()) {
  const y = on.getMonth() >= 3 ? on.getFullYear() : on.getFullYear() - 1
  return { fy: `${y}-${String((y + 1) % 100).padStart(2, '0')}`, cy: String(on.getFullYear()) }
}
/** What the next bill on a series would be called. */
export function preview(s: Pick<BillSeries, 'prefix' | 'suffix' | 'digits' | 'restart' | 'next_number'>): string {
  const { fy, cy } = years()
  const mid = s.restart === 'april' ? `${fy}/` : s.restart === 'january' ? `${cy}/` : ''
  return `${s.prefix}${mid}${String(s.next_number).padStart(s.digits, '0')}${s.suffix}`
}
const dateText = (iso: string | null) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Always')

export default function BillSeriesPage() {
  const { can } = useAccess()
  const manage = can('can_manage_erp_masters')
  const data = useQuery<BillSeriesData>('erp-bill-series', () => erp.billSeries())
  const [txn, setTxn] = useState('sales_invoice')
  const [editing, setEditing] = useState<BillSeries | 'new' | null>(null)
  const removing = useRun(() => data.reload())
  const people = useQuery<User[]>('erp-series-people', () => api.get<User[]>('/admin/employees'))

  const txns = data.data?.transactions ?? []
  const all = data.data?.series ?? []
  const here = all.filter((s) => s.transaction === txn)
  const current = txns.find((t) => t.key === txn)

  // F2 starts a new series and the arrows walk the transaction list, as the reference's footer says.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (editing || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'F2' && manage) { e.preventDefault(); setEditing('new') }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const i = txns.findIndex((t) => t.key === txn)
        const next = txns[i + (e.key === 'ArrowDown' ? 1 : -1)]
        if (next) { e.preventDefault(); setTxn(next.key) }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, manage, txn, txns])

  function remove(s: BillSeries) {
    if (!window.confirm(`Delete the series “${s.name}”? This cannot be undone.`)) return
    void removing.run(() => erp.deleteBillSeries(s.id), 'That series could not be deleted')
  }

  if (!data.data) return data.error ? <ErrorNote>{data.error}</ErrorNote> : <Loading />

  return (
    <div className="bs-compact">
      <p className="muted-sm" style={{ margin: '0 0 12px' }}>Number a transaction from more than one series — Retail and Wholesale, counter and online. The bill asks which one when there is a choice.</p>
      {removing.error && <div style={{ marginBottom: 10 }}><ErrorNote>{removing.error}</ErrorNote></div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 260px) minmax(0, 1fr)', gap: 20, alignItems: 'start' }}>
        <nav className="card" style={{ padding: 14 }} aria-label="Select transaction">
          <div className="muted-sm" style={{ letterSpacing: '.06em', textTransform: 'uppercase', fontSize: 11, margin: '2px 8px 6px' }}>Select transaction</div>
          {(['sales', 'purchase', 'others'] as const).map((g, gi) => (
            <div key={g} style={{ borderTop: gi ? '1px solid var(--border)' : 0, paddingTop: gi ? 6 : 0, marginTop: gi ? 6 : 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 8px', fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: GROUP_TONE[g].dot }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: GROUP_TONE[g].dot }} />{GROUP_TONE[g].label}
              </div>
              {txns.filter((t) => t.group === g).map((t) => {
                const n = all.filter((s) => s.transaction === t.key).length
                const on = t.key === txn
                return (
                  <button key={t.key} type="button" onClick={() => setTxn(t.key)} aria-current={on ? 'true' : undefined}
                          style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center', border: 0, borderRadius: 8, padding: '8px 10px', cursor: 'pointer', font: 'inherit', fontSize: 12.5,
                                   background: on ? 'var(--brand-soft)' : 'transparent', color: on ? 'var(--brand)' : 'var(--text-primary)', fontWeight: on ? 600 : 400 }}>
                    <span>{t.label}</span>
                    <span className="muted-sm" style={{ minWidth: 20, textAlign: 'center', borderRadius: 6, padding: '1px 6px', background: 'var(--surface-2)' }}>{n}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </nav>

        <section>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
            <div>
              <h2 className="card-title" style={{ margin: 0 }}>{current?.label}</h2>
              <p className="muted-sm" style={{ margin: '2px 0 0' }}>
                {here.length === 1 ? 'One series: every bill takes it. Add another with New Series (F2) to choose per bill.'
                  : `${here.length} series: the bill asks which one to take.`}
              </p>
            </div>
            {manage && <button className="btn btn-primary" onClick={() => setEditing('new')}><IconPlus size={15} /> New series</button>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 420px))', gap: 16 }}>
            {here.map((s) => <SeriesCard key={s.id} s={s} manage={manage} busy={removing.busy} people={people.data ?? []} onEdit={() => setEditing(s)} onDelete={() => remove(s)} />)}
          </div>
          <p className="muted-sm" style={{ margin: '14px 2px' }}>
            <kbd className="kbd">F2</kbd> New &nbsp; <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> Move
          </p>
        </section>
      </div>
      {editing && current && (
        <SeriesForm txnKey={txn} txnLabel={current.label} series={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
                    onSaved={() => { setEditing(null); data.reload() }} />
      )}
    </div>
  )
}

function SeriesCard({ s, manage, busy, people, onEdit, onDelete }: { s: BillSeries; manage: boolean; busy: boolean; people: User[]; onEdit: () => void; onDelete: () => void }) {
  const row = (k: string, v: ReactNode) => (
    <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 6, fontSize: 12 }}><span className="muted-sm">{k}</span><span>{v}</span></div>
  )
  const restart = s.restart === 'april' ? 'restarts each April' : s.restart === 'january' ? 'restarts each January' : 'never restarts'
  return (
    <article className="card" style={{ padding: 18, opacity: s.is_active ? 1 : 0.6 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>{s.name}</h3>
          {s.is_default && <span style={{ fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: '#fff3d6', color: '#9a6a00', border: '1px solid #f0d89a' }}>☆ Default</span>}
          {!s.is_active && <span className="muted-sm">inactive</span>}
        </div>
        {manage && (
          <div className="crm-row-actions">
            <button className="crm-icon-btn" onClick={onEdit} title="Modify" aria-label={`Modify ${s.name}`}><IconEdit size={14} /></button>
            <button className="crm-icon-btn crm-icon-danger" onClick={onDelete} disabled={busy} title="Delete" aria-label={`Delete ${s.name}`}><IconTrash size={14} /></button>
          </div>
        )}
      </header>
      {s.used_for && <p className="muted-sm" style={{ margin: '4px 0 0' }}>{s.used_for}</p>}
      <div style={{ margin: '14px 0', padding: '12px 14px', borderRadius: 10, background: 'var(--brand-soft)' }}>
        <div className="muted-sm" style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase' }}>Next number</div>
        <code style={{ fontSize: 15, fontWeight: 600 }}>{preview(s)}</code>
      </div>
      <div style={{ display: 'grid', gap: 7 }}>
        {row('Prefix / Suffix', <code>{s.prefix || '—'} / {s.suffix || '—'}</code>)}
        {row('Numbering', `${s.digits} digits · ${restart}`)}
        {row('Issued', s.issued ? `${s.issued} ${s.issued === 1 ? 'bill' : 'bills'}` : 'None yet')}
        {row('Applicable from', dateText(s.applicable_from))}
        {row('Print title', s.print_title ?? 'Standard')}
        {row('Default for', s.default_groups.length ? s.default_groups.join(', ') : '—')}
        {s.transaction === 'sales_invoice' && (
          <>
            {row('Billing', BILLING.find(([v]) => v === s.billing_type)?.[1] ?? 'Company Default')}
            {row('Print format', `${s.print_layout ?? 'Saved layout'} · ${PAPERS.find(([v]) => v === s.paper)?.[1].split(' — ')[0] ?? 'Saved paper'}`)}
            {row('Users', s.user_ids.length ? s.user_ids.map((id) => people.find((p) => p.id === id)?.full_name ?? '—').join(', ') : 'Everybody')}
          </>
        )}
      </div>
    </article>
  )
}

const SERIES_SECTIONS: FieldSection[] = [{ id: 'main', label: 'Series' }]
const SERIES_FIELDS: FieldDef[] = [
  { key: 'name', label: 'Series name', section: 'main', fixed: true },
  { key: 'used_for', label: 'Used for', section: 'main' },
  { key: 'prefix', label: 'Prefix', section: 'main' },
  { key: 'suffix', label: 'Suffix', section: 'main' },
  { key: 'digits', label: 'Digits', section: 'main', fixed: true },
  { key: 'restart', label: 'Restart numbering', section: 'main', fixed: true },
  { key: 'next', label: 'Next number', section: 'main', fixed: true },
  { key: 'applicable', label: 'Applicable from', section: 'main' },
  { key: 'print_title', label: 'Print title', section: 'main' },
  { key: 'groups', label: 'Default for parties under', section: 'main', optionalOnly: true },
  { key: 'billing', label: 'Billing type', section: 'main', optionalOnly: true },
  { key: 'layout', label: 'Print layout', section: 'main', optionalOnly: true },
  { key: 'paper', label: 'Paper', section: 'main', optionalOnly: true },
  { key: 'users', label: 'Users', section: 'main', optionalOnly: true },
  { key: 'default', label: 'Default series', section: 'main', fixed: true },
  { key: 'active', label: 'Active', section: 'main', fixed: true },
]

function SeriesForm({ txnKey, txnLabel, series, onClose, onSaved }: { txnKey: string; txnLabel: string; series: BillSeries | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: series?.name ?? '', used_for: series?.used_for ?? '', prefix: series?.prefix ?? '', suffix: series?.suffix ?? '', digits: String(series?.digits ?? 4),
    restart: (series?.restart ?? 'april') as BillSeries['restart'], next_number: String(series?.next_number ?? 1), applicable_from: series?.applicable_from ?? '',
    print_title: series?.print_title ?? '', groups: series?.default_groups ?? [], is_default: series?.is_default ?? false, is_active: series?.is_active ?? true,
    billing_type: (series?.billing_type ?? 'company') as BillSeries['billing_type'], print_layout: series?.print_layout ?? 'Saved layout',
    paper: series?.paper ?? 'saved', user_ids: series?.user_ids ?? [],
  })
  const people = useQuery<User[]>('erp-series-people', () => api.get<User[]>('/admin/employees'))
  const { busy, error, run } = useRun()
  const fields = useFieldModes('erp-bill-series-form', SERIES_FIELDS)
  const fm = fields.mode
  const rq = (k: string) => fm(k) === 'mandatory'
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((c) => ({ ...c, [k]: v }))
  const ledgers = useQuery<Ledger[]>('erp-series-ledgers', () => erp.ledgers())
  // The groups a bill's party can be under, with how many parties each holds.
  const counts = new Map<string, number>()
  for (const l of ledgers.data ?? []) counts.set(l.account_group, (counts.get(l.account_group) ?? 0) + 1)
  for (const g of ['Sundry Debtors', 'Sundry Creditors']) if (!counts.has(g)) counts.set(g, 0)
  f.groups.forEach((g) => { if (!counts.has(g)) counts.set(g, 0) })
  const groupNames = [...counts.keys()].sort()

  const minNext = series?.next_number ?? 1
  const nextBad = Number(f.next_number) < minNext
  const empty: Record<string, boolean> = { used_for: !f.used_for.trim(), prefix: !f.prefix.trim(), suffix: !f.suffix.trim(), applicable: !f.applicable_from, print_title: !f.print_title.trim() }
  const missing = !f.name.trim() || Object.keys(empty).some((k) => rq(k) && fm(k) !== 'hide' && empty[k])
  const { fy, cy } = years()
  const draft = { prefix: f.prefix, suffix: f.suffix, digits: Number(f.digits) || 4, restart: f.restart, next_number: Number(f.next_number) || 1 }

  function save() {
    void run(async () => {
      await erp.saveBillSeries({
        transaction: txnKey, name: f.name.trim(), used_for: f.used_for.trim() || null, prefix: f.prefix, suffix: f.suffix, digits: Number(f.digits) || 4,
        restart: f.restart, next_number: Number(f.next_number) || 1, applicable_from: f.applicable_from || null, print_title: f.print_title.trim() || null,
        default_groups: f.groups, is_default: f.is_default, is_active: f.is_active,
        billing_type: f.billing_type, print_layout: f.print_layout === 'Saved layout' ? null : f.print_layout, paper: f.paper, user_ids: f.user_ids,
      }, series?.id)
      onSaved()
    }, 'That series could not be saved')
  }

  const yesNo = (value: boolean, on: (v: boolean) => void) => (
    <div role="radiogroup" style={{ display: 'inline-flex', border: '1px solid var(--border-strong)', borderRadius: 10, padding: 3, gap: 2 }}>
      {([true, false] as const).map((v) => (
        <button key={String(v)} type="button" role="radio" aria-checked={value === v} onClick={() => on(v)}
                style={{ border: 0, borderRadius: 7, padding: '6px 16px', cursor: 'pointer', font: 'inherit', fontWeight: value === v ? 700 : 500,
                         background: value === v ? 'var(--brand-soft)' : 'transparent', color: value === v ? 'var(--brand)' : 'var(--text-secondary)' }}>
          {v ? 'Yes' : 'No'}
        </button>
      ))}
    </div>
  )

  const wide = (node: ReactNode) => <div style={{ gridColumn: '1 / -1' }}>{node}</div>
  const nodes: Record<string, ReactNode> = {
    name: wide(<Field label="Series name" required><input value={f.name} maxLength={120} autoFocus placeholder="e.g. Retail, Wholesale, Online" onChange={(e) => set('name', e.target.value)} /></Field>),
    used_for: fm('used_for') !== 'hide' && wide((
      <Field label="Used for" required={rq('used_for')} hint="Shown on the bill's Select Series, so whoever bills knows which series to take">
        <input value={f.used_for} maxLength={200} placeholder="e.g. Counter cash sales to walk-in customers" onChange={(e) => set('used_for', e.target.value)} />
      </Field>
    )),
    prefix: fm('prefix') !== 'hide' && <Field label="Prefix" required={rq('prefix')}><input value={f.prefix} maxLength={20} placeholder="e.g. R/" onChange={(e) => set('prefix', e.target.value)} /></Field>,
    suffix: fm('suffix') !== 'hide' && <Field label="Suffix" required={rq('suffix')}><input value={f.suffix} maxLength={20} placeholder="optional" onChange={(e) => set('suffix', e.target.value)} /></Field>,
    digits: (
      <Field label="Digits">
        <select value={f.digits} onChange={(e) => set('digits', e.target.value)}>
          {[1, 2, 3, 4, 5, 6, 7, 8].map((d) => <option key={d} value={d}>{d} ({'0'.repeat(d - 1)}1)</option>)}
        </select>
      </Field>
    ),
    restart: (
      <Field label="Restart numbering">
        <select value={f.restart} onChange={(e) => set('restart', e.target.value as BillSeries['restart'])}>
          {RESTART.map(([v, label]) => <option key={v} value={v}>{label(fy, cy)}</option>)}
        </select>
      </Field>
    ),
    next: (
      <Field label="Next number" hint={nextBad ? <span style={{ color: '#dc2626' }}>It is already {minNext} — it only moves forward.</span> : 'Only moves forward — a number once issued is never reissued'}>
        <input value={f.next_number} inputMode="numeric" onChange={(e) => set('next_number', e.target.value.replace(/\D/g, ''))} />
      </Field>
    ),
    applicable: fm('applicable') !== 'hide' && (
      <Field label="Applicable from" required={rq('applicable')} hint="Offered on bills dated from this day">
        <input type="date" value={f.applicable_from} onChange={(e) => set('applicable_from', e.target.value)} />
      </Field>
    ),
    print_title: fm('print_title') !== 'hide' && wide(<Field label="Print title" required={rq('print_title')}><input value={f.print_title} maxLength={120} placeholder="e.g. RETAIL INVOICE (left blank: the standard title)" onChange={(e) => set('print_title', e.target.value)} /></Field>),
    groups: fm('groups') !== 'hide' && wide((
        <div>
          <div className="muted-sm" style={{ fontWeight: 600, marginBottom: 6 }}>Default for parties under</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {groupNames.map((g) => {
              const on = f.groups.includes(g)
              return (
                <button key={g} type="button" aria-pressed={on} onClick={() => set('groups', on ? f.groups.filter((x) => x !== g) : [...f.groups, g])}
                        style={{ border: `1px solid ${on ? 'var(--brand)' : 'var(--border-strong)'}`, background: on ? 'var(--brand-soft)' : 'var(--surface-1)', color: on ? 'var(--brand)' : 'var(--text-primary)',
                                 borderRadius: 999, padding: '6px 14px', cursor: 'pointer', font: 'inherit', fontWeight: on ? 700 : 500 }}>
                  {g} <sup>{counts.get(g)}</sup>
                </button>
              )
            })}
          </div>
          <p className="muted-sm" style={{ margin: '6px 0 0' }}>A bill for a party in these groups starts on this series (the group is the party's A/c Group in the Ledger master)</p>
        </div>
    )),
    billing: fm('billing') !== 'hide' && wide((
        <div>
          <div className="muted-sm" style={{ fontWeight: 600, marginBottom: 6 }}>Billing type</div>
          <div role="radiogroup" style={{ display: 'inline-flex', border: '1px solid var(--border-strong)', borderRadius: 10, padding: 3, gap: 2 }}>
            {BILLING.map(([v, label]) => (
              <button key={v} type="button" role="radio" aria-checked={f.billing_type === v} onClick={() => set('billing_type', v)}
                      style={{ border: 0, borderRadius: 7, padding: '6px 16px', cursor: 'pointer', font: 'inherit', fontWeight: f.billing_type === v ? 700 : 500,
                               background: f.billing_type === v ? 'var(--brand-soft)' : 'transparent', color: f.billing_type === v ? 'var(--brand)' : 'var(--text-secondary)' }}>
                {label}
              </button>
            ))}
          </div>
          <p className="muted-sm" style={{ margin: '6px 0 0' }}>As Sale Bill Setting says. A bill on this series starts with its rates this way; the bill can still switch.</p>
        </div>
    )),
    layout: fm('layout') !== 'hide' && (
      <Field label="Print layout" hint="The layout this series' bills print in">
        <select value={f.print_layout} onChange={(e) => set('print_layout', e.target.value)}>
          {LAYOUTS.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </Field>
    ),
    paper: fm('paper') !== 'hide' && (
      <Field label="Paper" hint="Retail on a thermal roll, Wholesale on A4…">
        <select value={f.paper} onChange={(e) => set('paper', e.target.value)}>
          {PAPERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </Field>
    ),
    users: fm('users') !== 'hide' && wide((
        <div>
          <div className="muted-sm" style={{ fontWeight: 600, marginBottom: 6 }}>Users</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(people.data ?? []).filter((p) => p.is_active).map((p) => {
              const on = f.user_ids.includes(p.id)
              return (
                <button key={p.id} type="button" aria-pressed={on} onClick={() => set('user_ids', on ? f.user_ids.filter((x) => x !== p.id) : [...f.user_ids, p.id])}
                        style={{ border: `1px solid ${on ? 'var(--brand)' : 'var(--border-strong)'}`, background: on ? 'var(--brand-soft)' : 'var(--surface-1)', color: on ? 'var(--brand)' : 'var(--text-primary)',
                                 borderRadius: 999, padding: '6px 14px', cursor: 'pointer', font: 'inherit', fontWeight: on ? 700 : 500 }}>
                  {p.full_name} <span className="muted-sm" style={{ textTransform: 'capitalize' }}>{p.role}</span>
                </button>
              )
            })}
          </div>
          <p className="muted-sm" style={{ margin: '6px 0 0' }}>None picked: everybody can bill in this series.</p>
        </div>
    )),
    default: <div><div className="muted-sm" style={{ fontWeight: 600, marginBottom: 6 }}>Default series</div>{yesNo(f.is_default, (v) => set('is_default', v))}</div>,
    active: <div><div className="muted-sm" style={{ fontWeight: 600, marginBottom: 6 }}>Active</div>{yesNo(f.is_active, (v) => set('is_active', v))}</div>,
  }

  return (
    <Dialog wide title={series ? `Edit series · ${txnLabel}` : `New series · ${txnLabel}`}
            subtitle="The number a bill takes: prefix, the year if it restarts yearly, the running number, suffix." onClose={onClose}
            footer={<>
              <span className="muted-sm">Next bill: <code>{preview(draft)}</code></span>
              {error && <span className="error">{error}</span>}
              {!error && missing && <span className="lf-foot-note lf-foot-link">Series name required</span>}
              <button className="btn crm-push" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || missing || nextBad} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
            </>}>
      <div className="bs-compact" style={{ display: 'grid', gap: 12, padding: '6px 22px 16px', overflowY: 'auto', minHeight: 0, flex: 1, alignContent: 'start' }}>
        <div className="lf-settings">
          <FieldSettings defs={SERIES_FIELDS} sections={SERIES_SECTIONS} modes={fields.modes} order={fields.order}
                         onSave={fields.save} onReset={fields.reset} title="Series fields" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {fields.orderOf('main').map((key) => <div key={key} style={{ display: 'contents' }}>{nodes[key]}</div>)}
        </div>
      </div>
    </Dialog>
  )
}
