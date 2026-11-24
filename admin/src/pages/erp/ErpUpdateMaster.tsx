/* Master -> Update Master: Ledger Openings, Stock Openings, Rack Update and Print Barcode. */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '../../lib/useQuery'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconBuilding, IconSearch } from '../../components/Icons'
import { code128Svg, ean13Svg } from '../../lib/code128'
import { Link } from 'react-router-dom'
import { useAuth } from '../../lib/auth'
import { Dialog, Field, useAccess, useRun } from './parts'
import { erp, rupees, type Item, type Ledger, type OpeningLot, type StockOpeningRow, type Warehouse } from './api'

const Search = ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) => (
  <div className="crm-search">
    <IconSearch size={15} />
    <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
  </div>
)

function Head({ title, blurb, children }: { title: string; blurb: string; children?: ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '14px 18px', flexWrap: 'wrap' }}>
      <div>
        <h2 className="card-title" style={{ margin: 0 }}>{title}</h2>
        <p className="muted-sm" style={{ margin: '2px 0 0' }}>{blurb}</p>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{children}</div>
    </div>
  )
}

/* ================================================================ Ledger Openings */

interface Draft { balance: string; type: 'dr' | 'cr' }

/** The financial year trading opens in: 1 April of the year that has just begun or is running. */
const fyStart = () => { const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return `01/04/${y}` }

const foot: React.CSSProperties = { display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap', padding: '10px 18px', borderTop: '1px solid var(--border)', background: 'var(--surface-2, transparent)' }

export function LedgerOpenings() {
  const { can } = useAccess()
  const manage = can('can_manage_erp_masters')
  const list = useQuery<Ledger[]>('erp-openings-ledgers', () => erp.ledgers())
  const [q, setQ] = useState('')
  const [group, setGroup] = useState('')
  const [station, setStation] = useState('')
  const [withBalance, setWithBalance] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [saved, setSaved] = useState<string | null>(null)
  const { busy, error, run } = useRun()
  const all = list.data ?? []
  const needle = q.trim().toLowerCase()
  const draftOf = (l: Ledger): Draft => drafts[l.id] ?? { balance: String(Number(l.opening_balance)), type: l.opening_type }
  const rows = all.filter((l) => (!group || l.account_group === group) && (!station || l.station === station)
    && (!withBalance || Number(draftOf(l).balance || 0) !== 0)
    && (!needle || [l.name, l.code, l.station].some((x) => x && x.toLowerCase().includes(needle))))
  const dirty = all.filter((l) => {
    const d = drafts[l.id]
    return d && (Number(d.balance || 0) !== Number(l.opening_balance) || d.type !== l.opening_type)
  })
  const set = (l: Ledger, patch: Partial<Draft>) => { setSaved(null); setDrafts((c) => ({ ...c, [l.id]: { ...draftOf(l), ...patch } })) }
  // What the opening entries add up to; the books must balance, so any difference goes to Opening Balance Equity.
  let dr = 0, cr = 0
  for (const l of all) { const d = draftOf(l); const n = Number(d.balance || 0); if (d.type === 'dr') dr += n; else cr += n }
  const diff = dr - cr

  function save() {
    void run(async () => {
      const r = await erp.saveOpenings(dirty.map((l) => ({ id: l.id, opening_balance: drafts[l.id].balance || '0', opening_type: drafts[l.id].type })))
      setDrafts({})
      setSaved(`${r.updated} ledger${r.updated === 1 ? '' : 's'} updated.`)
      list.reload()
    }, 'The openings could not be saved')
  }

  return (
    <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <Head title="Ledger Openings" blurb="The balance each ledger starts with, Dr (they owe you) or Cr (you owe them). Change several, then save once.">
        {manage && <button className="btn btn-primary" disabled={busy || dirty.length === 0} onClick={save}>{busy ? 'Saving…' : dirty.length ? `Save ${dirty.length} change${dirty.length === 1 ? '' : 's'}` : 'Save changes'}</button>}
      </Head>
      <div className="crm-bar itl-bar" style={{ borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <Search value={q} onChange={setQ} placeholder="Ledger name or code…" />
        <select value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Account group" style={{ maxWidth: 220 }}>
          <option value="">All groups</option>
          {[...new Set(all.map((l) => l.account_group))].sort().map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <select value={station} onChange={(e) => setStation(e.target.value)} aria-label="Station" style={{ maxWidth: 200 }}>
          <option value="">All stations</option>
          {[...new Set(all.map((l) => l.station).filter(Boolean) as string[])].sort().map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <label className="muted-sm" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={withBalance} onChange={(e) => setWithBalance(e.target.checked)} /> With balance only</label>
        <span className="itl-count crm-push">As on <b>{fyStart()}</b> · Ledgers: <b>{all.length}</b></span>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {list.error && <ErrorNote>{list.error}</ErrorNote>}
      {saved && <p className="muted-sm" style={{ margin: '8px 18px' }}>{saved}</p>}
      {!list.data ? <Loading /> : rows.length === 0 ? (
        <EmptyState icon={<IconBuilding size={22} />} title={all.length ? 'Nothing matches' : 'No ledgers yet'} body={all.length ? 'Change the search or the filters.' : 'Create ledgers first, then set what they start with.'} />
      ) : (
        <div className="table-wrap" style={{ maxHeight: '60vh', overflowY: 'auto' }}><table className="itl">
          <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}><tr><th style={{ width: 90 }}>Code</th><th>Ledger name</th><th>Group</th><th>Station</th><th style={{ width: 200 }}>Opening balance ₹</th><th style={{ width: 90 }}>Dr / Cr</th></tr></thead>
          <tbody>
            {rows.map((l) => {
              const d = draftOf(l)
              const changed = drafts[l.id] && (Number(d.balance || 0) !== Number(l.opening_balance) || d.type !== l.opening_type)
              return (
                <tr key={l.id} style={changed ? { background: 'var(--brand-soft)' } : undefined}>
                  <td className="crm-code">{l.code}</td>
                  <td><b>{l.name}</b></td>
                  <td>{l.account_group}</td>
                  <td>{l.station ?? '—'}</td>
                  <td><input value={d.balance} inputMode="decimal" disabled={!manage} aria-label={`Opening balance of ${l.name}`} style={{ textAlign: 'right', width: '100%' }}
                             onChange={(e) => set(l, { balance: e.target.value.replace(/[^\d.]/g, '') })} /></td>
                  <td><select value={d.type} disabled={!manage} aria-label={`Dr or Cr for ${l.name}`} onChange={(e) => set(l, { type: e.target.value as 'dr' | 'cr' })}><option value="dr">Dr</option><option value="cr">Cr</option></select></td>
                </tr>
              )
            })}
          </tbody>
        </table></div>
      )}
      <div style={foot}>
        <span>Total Dr <b>{rupees(dr)}</b></span>
        <span>Total Cr <b>{rupees(cr)}</b></span>
        {diff === 0
          ? <span className="muted-sm">Debits and credits agree.</span>
          : <span style={{ color: 'var(--warn, #b45309)' }}>Difference <b>{rupees(Math.abs(diff))} {diff > 0 ? 'Dr' : 'Cr'}</b> → Opening Balance Equity</span>}
      </div>
    </section>
  )
}

/* ================================================================ Stock Openings */

interface StockDraft { quantity: string; rate: string }
const num = (s: string) => Number(s || 0)

export function StockOpenings() {
  const { can } = useAccess()
  const manage = can('can_manage_inventory')
  const stores = useQuery<Warehouse[]>('erp-opening-stores', () => erp.warehouses(true))
  const [store, setStore] = useState('')
  const [q, setQ] = useState('')
  const [company, setCompany] = useState('')
  const [category, setCategory] = useState('')
  const [withStock, setWithStock] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, StockDraft>>({})
  const [lotsFor, setLotsFor] = useState<StockOpeningRow | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const { busy, error, run } = useRun()
  const storeList = stores.data ?? []
  const storeId = store || storeList.find((w) => w.is_default)?.id || storeList[0]?.id || ''
  const storeName = storeList.find((w) => w.id === storeId)?.name ?? ''
  const rowsQ = useQuery<StockOpeningRow[]>(`erp-stock-openings-${storeId}`, () => erp.stockOpenings({ warehouse_id: storeId }), { enabled: !!storeId })
  const all = rowsQ.data ?? []
  const needle = q.trim().toLowerCase()
  const draftOf = (r: StockOpeningRow): StockDraft => drafts[r.item_id] ?? { quantity: String(num(r.quantity)), rate: String(num(r.rate)) }
  const rows = all.filter((r) => (!company || r.make === company) && (!category || r.category === category)
    && (!withStock || num(draftOf(r).quantity) > 0) && (!needle || [r.code, r.name].some((x) => x.toLowerCase().includes(needle))))
  const dirty = all.filter((r) => { const d = drafts[r.item_id]; return d && r.lot_count <= 1 && (num(d.quantity) !== num(r.quantity) || num(d.rate) !== num(r.rate)) })
  const totalValue = all.reduce((s, r) => { const d = draftOf(r); return s + (r.lot_count > 1 ? num(r.value) : num(d.quantity) * num(d.rate)) }, 0)
  const set = (r: StockOpeningRow, patch: Partial<StockDraft>) => { setNote(null); setDrafts((c) => ({ ...c, [r.item_id]: { ...draftOf(r), ...patch } })) }

  function saveAll() {
    void run(async () => {
      for (const r of dirty) {
        const d = drafts[r.item_id]
        // A single lot keeps its barcode, MRP and sale rates; only quantity and purchase rate change.
        const existing = r.lot_count === 1 ? (await erp.openingLots(r.item_id, storeId))[0] : undefined
        const { id: _id, value: _v, ...keep } = existing ?? ({} as Partial<OpeningLot>)
        await erp.saveOpeningLots(r.item_id, storeId, [{ ...keep, quantity: d.quantity || '0', pur_rate: d.rate || '0' }])
      }
      setDrafts({})
      setNote(`${dirty.length} item${dirty.length === 1 ? '' : 's'} updated.`)
      rowsQ.reload()
    }, 'The opening stock could not be saved')
  }

  return (
    <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <Head title="Stock Openings" blurb="What each item held in a store when trading started. Type a quantity and rate, or use Enter lots for items held by batch. Serialised items are opened through Opening stock in Inventory.">
        {manage && <button className="btn btn-primary" disabled={busy || dirty.length === 0} onClick={saveAll}>{busy ? 'Saving…' : dirty.length ? `Save ${dirty.length} change${dirty.length === 1 ? '' : 's'}` : 'Save changes'}</button>}
      </Head>
      <div className="crm-bar itl-bar" style={{ borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <Search value={q} onChange={setQ} placeholder="Item name or code…" />
        <select value={storeId} onChange={(e) => { setStore(e.target.value); setDrafts({}) }} aria-label="Store" style={{ maxWidth: 200 }}>
          {storeList.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select value={company} onChange={(e) => setCompany(e.target.value)} aria-label="Company" style={{ maxWidth: 200 }}>
          <option value="">All companies</option>
          {[...new Set(all.map((r) => r.make).filter(Boolean) as string[])].sort().map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" style={{ maxWidth: 200 }}>
          <option value="">All categories</option>
          {[...new Set(all.map((r) => r.category).filter(Boolean) as string[])].sort().map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label className="muted-sm" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={withStock} onChange={(e) => setWithStock(e.target.checked)} /> With stock only</label>
        <span className="itl-count crm-push">Items: <b>{all.length}</b></span>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {rowsQ.error && <ErrorNote>{rowsQ.error}</ErrorNote>}
      {note && <p className="muted-sm" style={{ margin: '8px 18px' }}>{note}</p>}
      {stores.data && storeList.length === 0 ? (
        <EmptyState icon={<IconBuilding size={22} />} title="No store yet" body="Create a store first; opening stock is held in one." />
      ) : !rowsQ.data ? <Loading /> : rows.length === 0 ? (
        <EmptyState icon={<IconBuilding size={22} />} title={all.length ? 'Nothing matches' : 'No stocked items yet'} body={all.length ? 'Change the search or the filters.' : 'Add goods items first, then enter what you hold.'} />
      ) : (
        <div className="table-wrap" style={{ maxHeight: '60vh', overflowY: 'auto' }}><table className="itl">
          <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}><tr>
            <th style={{ width: 110 }}>Code</th><th>Item name</th><th style={{ width: 70 }}>Unit</th><th>Store</th>
            <th style={{ width: 130 }}>Quantity</th><th style={{ width: 130 }}>Rate ₹</th><th style={{ width: 120, textAlign: 'right' }}>Value ₹</th><th style={{ width: 130 }} />
          </tr></thead>
          <tbody>
            {rows.map((r) => {
              const d = draftOf(r)
              const lots = r.lot_count > 1
              const changed = !lots && drafts[r.item_id] && (num(d.quantity) !== num(r.quantity) || num(d.rate) !== num(r.rate))
              return (
                <tr key={r.item_id} style={changed ? { background: 'var(--brand-soft)' } : undefined}>
                  <td className="crm-code">{r.code}</td>
                  <td><b>{r.name}</b><div className="muted-sm">{[r.make, r.category].filter(Boolean).join(' · ') || ' '}</div></td>
                  <td>{r.uom}</td>
                  <td className="muted-sm">{storeName}</td>
                  <td>{lots ? <span title="Held in several lots">{num(r.quantity)} <span className="muted-sm">({r.lot_count} lots)</span></span>
                    : <input value={d.quantity} inputMode="decimal" disabled={!manage} aria-label={`Opening quantity of ${r.name}`} style={{ textAlign: 'right', width: '100%' }} onChange={(e) => set(r, { quantity: e.target.value.replace(/[^\d.]/g, '') })} />}</td>
                  <td>{lots ? <span>{rupees(num(r.rate))}</span>
                    : <input value={d.rate} inputMode="decimal" disabled={!manage} aria-label={`Rate of ${r.name}`} style={{ textAlign: 'right', width: '100%' }} onChange={(e) => set(r, { rate: e.target.value.replace(/[^\d.]/g, '') })} />}</td>
                  <td style={{ textAlign: 'right' }}>{lots ? rupees(num(r.value)) : num(d.quantity) * num(d.rate) ? rupees(num(d.quantity) * num(d.rate)) : '—'}</td>
                  <td>{manage && <button className="btn btn-sm" disabled={!!changed} title={changed ? 'Save your changes first' : undefined} onClick={() => setLotsFor(r)}>Enter lots ›</button>}</td>
                </tr>
              )
            })}
          </tbody>
        </table></div>
      )}
      <div style={foot}><span>Opening stock value <b>{rupees(totalValue)}</b></span></div>
      {lotsFor && <LotsDialog row={lotsFor} storeId={storeId} onClose={() => setLotsFor(null)} onSaved={() => { setLotsFor(null); rowsQ.reload() }} />}
    </section>
  )
}

interface LotDraft { lot_no: string; barcode: string; mrp: string; quantity: string; pur_rate: string; rate_a: string; rate_b: string; rate_c: string }
const BLANK_LOT: LotDraft = { lot_no: '', barcode: '', mrp: '', quantity: '', pur_rate: '', rate_a: '', rate_b: '', rate_c: '' }
const LOT_MONEY: Array<[keyof LotDraft, string]> = [['mrp', 'M.R.P.'], ['quantity', 'Opening *'], ['pur_rate', 'Pur. rate'], ['rate_a', 'Sale rate (A)'], ['rate_b', 'Rate (B)'], ['rate_c', 'Rate (C)']]

function LotsDialog({ row, storeId, onClose, onSaved }: { row: StockOpeningRow; storeId: string; onClose: () => void; onSaved: () => void }) {
  const [lots, setLots] = useState<LotDraft[] | null>(null)
  const { busy, error, run } = useRun()
  useEffect(() => {
    void erp.openingLots(row.item_id, storeId).then((l) => {
      const n = (s: string) => (num(s) ? String(num(s)) : '')
      setLots(l.length ? l.map((x) => ({ lot_no: x.lot_no, barcode: x.barcode ?? '', mrp: n(x.mrp), quantity: n(x.quantity), pur_rate: n(x.pur_rate), rate_a: n(x.rate_a), rate_b: n(x.rate_b), rate_c: n(x.rate_c) })) : [{ ...BLANK_LOT }])
    }).catch(() => setLots([{ ...BLANK_LOT }]))
  }, [row.item_id, storeId])
  const list = lots ?? []
  const set = (i: number, patch: Partial<LotDraft>) => setLots((c) => (c ?? []).map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const totalQty = list.reduce((s, l) => s + num(l.quantity), 0)
  const totalValue = list.reduce((s, l) => s + num(l.quantity) * num(l.pur_rate), 0)
  const bad = list.some((l) => (l.lot_no || l.barcode) && !num(l.quantity))

  function done() {
    void run(async () => {
      await erp.saveOpeningLots(row.item_id, storeId, list.map((l) => ({
        lot_no: l.lot_no, barcode: l.barcode, quantity: l.quantity || '0', mrp: l.mrp || '0', pur_rate: l.pur_rate || '0',
        rate_a: l.rate_a || '0', rate_b: l.rate_b || '0', rate_c: l.rate_c || '0',
      })))
      onSaved()
    }, 'The lots could not be saved')
  }

  return (
    <Dialog wide title="Secondary Stock · Opening" subtitle={<>{row.name} <span className="muted-sm">{row.code} · {row.uom}. S.Stock No. is generated when left blank</span></>} onClose={onClose}
            footer={<>
              {error && <span className="error">{error}</span>}
              {!error && bad && <span className="lf-foot-note lf-foot-link">Enter the opening quantity of every lot</span>}
              <button className="btn crm-push" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || !lots || bad} onClick={done}>{busy ? 'Saving…' : 'Done'}</button>
            </>}>
      <div style={{ overflowY: 'auto', minHeight: 0, flex: 1 }}>
        <div className="table-wrap"><table className="itl">
          <thead><tr><th style={{ width: 32 }}>#</th><th>S.Stock No.</th><th>Barcode</th>{LOT_MONEY.map(([k, label]) => <th key={k} style={{ textAlign: 'right' }}>{label.replace('*', '')}{label.includes('*') && <span className="lf-req"> *</span>}</th>)}<th style={{ textAlign: 'right' }}>Value ₹</th><th style={{ width: 32 }} /></tr></thead>
          <tbody>
            {list.map((l, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td><input value={l.lot_no} placeholder="Auto" aria-label={`S.Stock No., lot ${i + 1}`} onChange={(e) => set(i, { lot_no: e.target.value })} /></td>
                <td><input value={l.barcode} placeholder="Scan or type" aria-label={`Barcode, lot ${i + 1}`} onChange={(e) => set(i, { barcode: e.target.value })} /></td>
                {LOT_MONEY.map(([k, label]) => (
                  <td key={k}><input value={l[k]} inputMode="decimal" placeholder="0.00" aria-label={`${label.replace(' *', '')}, lot ${i + 1}`} style={{ textAlign: 'right', width: 90 }}
                                     onChange={(e) => set(i, { [k]: e.target.value.replace(/[^\d.]/g, '') } as Partial<LotDraft>)} /></td>
                ))}
                <td style={{ textAlign: 'right' }}>{num(l.quantity) * num(l.pur_rate) ? rupees(num(l.quantity) * num(l.pur_rate)) : '—'}</td>
                <td><button type="button" className="btn btn-sm" aria-label={`Remove lot ${i + 1}`} onClick={() => setLots(list.filter((_, j) => j !== i))}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 22, padding: '12px 4px' }}>
          <button type="button" className="btn" onClick={() => setLots([...list, { ...BLANK_LOT }])}>+ Add lot</button>
          <span className="crm-push muted-sm">Lots <b>{list.length}</b> · Opening <b>{totalQty} {row.uom}</b> · Value <b>{rupees(totalValue)}</b></span>
        </div>
      </div>
    </Dialog>
  )
}

/* ================================================================ Rack Update */

export function RackUpdate() {
  const { can } = useAccess()
  const manage = can('can_manage_erp_masters')
  const items = useQuery<Item[]>('erp-rack-items', () => erp.items())
  const racks = useQuery('erp-rack-racks', () => erp.lookups('rack', { active: true }))
  const [q, setQ] = useState('')
  const [company, setCompany] = useState('')
  const [onRack, setOnRack] = useState('')           // 'none' = on no rack
  const [drafts, setDrafts] = useState<Record<string, string>>({})   // item id -> rack name ('' = no rack)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [bulk, setBulk] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const { busy, error, run } = useRun()
  const all = (items.data ?? []).filter((i) => i.item_type === 'goods' && i.is_active)
  const rackList = racks.data ?? []
  const rackOf = (i: Item) => drafts[i.id] ?? i.rack ?? ''
  const needle = q.trim().toLowerCase()
  const rows = all.filter((i) => (!company || i.make === company) && (!onRack || (onRack === 'none' ? !rackOf(i) : rackOf(i) === onRack))
    && (!needle || [i.code, i.name, i.barcode, i.make].some((x) => x && x.toLowerCase().includes(needle))))
  const dirty = all.filter((i) => drafts[i.id] !== undefined && drafts[i.id] !== (i.rack ?? ''))
  const allOn = rows.length > 0 && rows.every((i) => picked.has(i.id))
  const stores = new Set(rackList.map((r) => r.parent_name).filter(Boolean)).size
  const toggle = (id: string) => setPicked((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const setRack = (id: string, rack: string) => { setNote(null); setDrafts((c) => ({ ...c, [id]: rack })) }

  function applyBulk() { setNote(null); setDrafts((c) => ({ ...c, ...Object.fromEntries([...picked].map((id) => [id, bulk])) })); setPicked(new Set()) }

  function update() {
    void run(async () => {
      const byRack = new Map<string, string[]>()
      for (const i of dirty) byRack.set(drafts[i.id], [...(byRack.get(drafts[i.id]) ?? []), i.id])
      for (const [rack, ids] of byRack) await erp.assignRack(rack || null, ids)
      setNote(`${dirty.length} item${dirty.length === 1 ? '' : 's'} updated.`)
      setDrafts({})
      items.reload()
    }, 'The racks could not be updated')
  }

  return (
    <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <Head title="Rack Update" blurb={`${all.length} item${all.length === 1 ? '' : 's'} · ${all.filter((i) => !rackOf(i)).length} not on any rack · ${rackList.length} rack${rackList.length === 1 ? '' : 's'} in ${stores} store${stores === 1 ? '' : 's'}`}>
        <Link to="/masters/erp/racks" className="btn btn-sm">+ Racks</Link>
        {manage && <>
          <button className="btn btn-sm" disabled={busy || dirty.length === 0} onClick={() => { setDrafts({}); setNote(null) }}>Discard</button>
          <button className="btn btn-primary" disabled={busy || dirty.length === 0} onClick={update}>{busy ? 'Saving…' : dirty.length ? `Update ${dirty.length}` : 'Update'}</button>
        </>}
      </Head>
      <div className="crm-bar itl-bar" style={{ borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <Search value={q} onChange={setQ} placeholder="Search item, code, barcode or company" />
        <select value={company} onChange={(e) => setCompany(e.target.value)} aria-label="Company" style={{ maxWidth: 220 }}>
          <option value="">All companies</option>
          {[...new Set(all.map((i) => i.make).filter(Boolean) as string[])].sort().map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={onRack} onChange={(e) => setOnRack(e.target.value)} aria-label="Items on" style={{ maxWidth: 220 }}>
          <option value="">All racks</option><option value="none">On no rack</option>
          {rackList.map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}
        </select>
      </div>
      {picked.size > 0 && manage && (
        <div className="crm-bar itl-bar" style={{ gap: 8 }}>
          <span className="muted-sm">{picked.size} ticked:</span>
          <select value={bulk} onChange={(e) => setBulk(e.target.value)} aria-label="Rack for the ticked items" style={{ maxWidth: 240 }}>
            <option value="">No rack</option>
            {rackList.map((r) => <option key={r.id} value={r.name}>{r.name} — {r.parent_name}</option>)}
          </select>
          <button className="btn btn-sm" onClick={applyBulk}>Set rack</button>
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      {items.error && <ErrorNote>{items.error}</ErrorNote>}
      {note && <p className="muted-sm" style={{ margin: '8px 18px' }}>{note}</p>}
      {!items.data ? <Loading /> : rows.length === 0 ? (
        <EmptyState icon={<IconBuilding size={22} />} title={all.length ? 'Nothing matches' : 'No items yet'} body={all.length ? 'Change the search or the filters.' : 'Add goods items first, then put them on racks.'} />
      ) : (
        <div className="table-wrap"><table className="itl">
          <thead><tr>
            <th style={{ width: 36 }}><input type="checkbox" checked={allOn} aria-label="Select all shown" onChange={() => setPicked(allOn ? new Set() : new Set(rows.map((i) => i.id)))} /></th>
            <th>Item code</th><th>Item name</th><th>Unit</th><th>Company name</th><th style={{ width: 260 }}>Rack no.</th>
          </tr></thead>
          <tbody>
            {rows.map((i) => {
              const changed = drafts[i.id] !== undefined && drafts[i.id] !== (i.rack ?? '')
              return (
                <tr key={i.id} style={{ background: changed ? 'var(--brand-soft)' : undefined }}>
                  <td><input type="checkbox" checked={picked.has(i.id)} disabled={!manage} aria-label={`Select ${i.name}`} onChange={() => toggle(i.id)} /></td>
                  <td className="crm-code">{i.code}</td><td><b>{i.name}</b></td><td>{i.uom}</td><td>{i.make ?? '—'}</td>
                  <td>
                    <select value={rackOf(i)} disabled={!manage} aria-label={`Rack of ${i.name}`} style={{ width: '100%' }} onChange={(e) => setRack(i.id, e.target.value)}>
                      <option value="">No rack</option>
                      {rackOf(i) && !rackList.some((r) => r.name === rackOf(i)) && <option value={rackOf(i)}>{rackOf(i)}</option>}
                      {rackList.map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}
                    </select>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table></div>
      )}
    </section>
  )
}

/* ================================================================ Print Barcode */

interface Paper { key: string; label: string; sub: string; w: number; h: number; cols: number; rows: number; sheet: boolean }
const PAPERS: Paper[] = [
  { key: 'a65', label: '65 labels', sub: '38.1 × 21.2 mm', w: 38.1, h: 21.2, cols: 5, rows: 13, sheet: true },
  { key: 'a48', label: '48 labels', sub: '48 × 24 mm', w: 48, h: 24, cols: 4, rows: 12, sheet: true },
  { key: 'a40', label: '40 labels', sub: '52.5 × 29.7 mm', w: 52.5, h: 29.7, cols: 4, rows: 10, sheet: true },
  { key: 'a24', label: '24 labels', sub: '64 × 34 mm', w: 64, h: 34, cols: 3, rows: 8, sheet: true },
  { key: 'a21', label: '21 labels', sub: '63.5 × 38.1 mm', w: 63.5, h: 38.1, cols: 3, rows: 7, sheet: true },
  { key: 'a12', label: '12 labels', sub: '105 × 48 mm', w: 105, h: 48, cols: 2, rows: 6, sheet: true },
  { key: 'r50x25', label: 'Single', sub: '50 × 25 mm', w: 50, h: 25, cols: 1, rows: 1, sheet: false },
  { key: 'r38x25', label: 'Single', sub: '38 × 25 mm', w: 38, h: 25, cols: 1, rows: 1, sheet: false },
  { key: 'r2x38', label: '2 across', sub: '38 × 25 mm', w: 38, h: 25, cols: 2, rows: 1, sheet: false },
  { key: 'r50x38', label: 'Single', sub: '50 × 38 mm', w: 50, h: 38, cols: 1, rows: 1, sheet: false },
  { key: 'r75x50', label: 'Single', sub: '75 × 50 mm', w: 75, h: 50, cols: 1, rows: 1, sheet: false },
  { key: 'r100x50', label: 'Single', sub: '100 × 50 mm', w: 100, h: 50, cols: 1, rows: 1, sheet: false },
]
const LINE_OPTIONS: Array<[string, string]> = [['none', 'None'], ['firm', 'Your firm name'], ['name', 'Item name'], ['code', 'Item code'], ['rate', 'Sale rate'], ['hsn', 'HSN'], ['company', 'Company'], ['category', 'Category']]
interface LabelSettings {
  paper: string; custom: boolean; cw: number; ch: number; kind: 'code128' | 'ean13'; start: number; number: boolean
  header: string; l1: string; l2: string; l3: string; l4: string; rupee: boolean; captions: boolean
}
const DEFAULT_SETTINGS: LabelSettings = { paper: 'a24', custom: false, cw: 50, ch: 25, kind: 'code128', start: 1, number: true, header: 'firm', l1: 'name', l2: 'company', l3: 'rate', l4: 'none', rupee: true, captions: true }
const SETTINGS_KEY = 'erp-label-settings'
const loadSettings = (): LabelSettings => { try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') } } catch { return DEFAULT_SETTINGS } }
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

/** The paper in use: a preset, or the shop's own sticker size. */
function paperOf(s: LabelSettings): Paper {
  if (s.custom) return { key: 'custom', label: 'Custom size', sub: `${s.cw} × ${s.ch} mm`, w: s.cw, h: s.ch, cols: 1, rows: 1, sheet: false }
  return PAPERS.find((p) => p.key === s.paper) ?? PAPERS[3]
}

const LABEL_CSS = `.lab{box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;background:#fff;color:#000;font:8px system-ui,sans-serif;text-align:center;padding:1mm 1.5mm;line-height:1.15}
.lab .row{display:flex;justify-content:space-between;width:100%}.lab .nm{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.lab .num{font:7px ui-monospace,monospace;letter-spacing:.5px}`

interface LabelItem { name: string; code: string; barcode: string; rate: number; hsn: string; company: string; category: string }

function barcodeSvg(value: string, kind: LabelSettings['kind'], h: number): string {
  return (kind === 'ean13' ? ean13Svg(value, { module: 1.4, height: h }) : null) ?? code128Svg(value, { module: 1.4, height: h })
}

function labelHtml(it: LabelItem, s: LabelSettings, firm: string, paper: Paper): string {
  const text = (k: string): string => {
    switch (k) {
      case 'firm': return firm
      case 'name': return it.name
      case 'code': return it.code
      case 'rate': return it.rate ? `${s.captions ? 'Rate ' : ''}${s.rupee ? '₹' : ''}${it.rate}` : ''
      case 'hsn': return it.hsn ? `${s.captions ? 'HSN ' : ''}${it.hsn}` : ''
      case 'company': return it.company
      case 'category': return it.category
      default: return ''
    }
  }
  const value = it.barcode || it.code
  const bars = Math.max(6, paper.h - 15)
  const line = (k: string, cls = 'nm') => (text(k) ? `<div class="${cls}">${esc(text(k))}</div>` : '')
  return `<div class="lab" style="width:${paper.w}mm;height:${paper.h}mm">
    ${line(s.header)}
    <div style="width:${paper.w - 8}mm;height:${bars}mm">${barcodeSvg(value, s.kind, 34).replace('<svg ', '<svg style="width:100%;height:100%" ')}</div>
    ${s.number ? `<div class="num">${esc(value)}</div>` : ''}${line(s.l1)}
    <div class="row"><span>${esc(text(s.l2))}</span><span>${esc(text(s.l3))}</span></div>${line(s.l4)}
  </div>`
}

export function PrintBarcode() {
  const { organization } = useAuth()
  const firm = organization?.name ?? 'Your firm'
  const items = useQuery<Item[]>('erp-barcode-items', () => erp.items())
  const stockQ = useQuery('erp-barcode-stock', () => erp.stock())
  const [settings, setSettings] = useState<LabelSettings>(loadSettings)
  const [open, setOpen] = useState(false)
  const [copies, setCopies] = useState<Record<string, number>>({})   // present = on the list
  const [pick, setPick] = useState('')
  const [category, setCategory] = useState('')
  const [company, setCompany] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const all = (items.data ?? []).filter((i) => i.item_type === 'goods' && i.is_active)
  const stock = useMemo(() => { const m = new Map<string, number>(); for (const r of stockQ.data ?? []) m.set(r.item_id, (m.get(r.item_id) ?? 0) + Number(r.quantity)); return m }, [stockQ.data])
  const paper = paperOf(settings)
  const perSheet = paper.cols * paper.rows
  const listed = all.filter((i) => copies[i.id] !== undefined)
  const labels = listed.reduce((n, i) => n + (copies[i.id] || 0), 0)
  const sheets = paper.sheet ? Math.ceil((labels + settings.start - 1) / perSheet) : 0
  const noBarcode = listed.filter((i) => !i.barcode).length
  const change = (patch: Partial<LabelSettings>) => setSettings((c) => { const n = { ...c, ...patch }; try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(n)) } catch { /* private mode */ } return n })
  const add = (ids: string[]) => setCopies((c) => ({ ...c, ...Object.fromEntries(ids.filter((id) => c[id] === undefined).map((id) => [id, 1])) }))
  const asLabel = (i: Item): LabelItem => ({ name: i.name, code: i.code, barcode: i.barcode ?? '', rate: Number(i.sale_price), hsn: i.hsn_sac ?? '', company: i.make ?? '', category: i.category ?? '' })
  const sample: LabelItem = listed[0] ? asLabel(listed[0]) : { name: 'Item name', code: 'ITEM0001', barcode: '', rate: 0, hsn: '', company: '', category: '' }

  function print() {
    const cells: string[] = []
    if (paper.sheet) for (let n = 1; n < settings.start; n++) cells.push(`<div style="width:${paper.w}mm;height:${paper.h}mm"></div>`)
    for (const i of listed) for (let n = 0; n < (copies[i.id] || 0); n++) cells.push(labelHtml(asLabel(i), settings, firm, paper))
    const win = window.open('', '_blank')
    if (!win) { setNote('Allow pop-ups to print the labels.'); return }
    let body: string
    if (paper.sheet) {
      const pages: string[] = []
      for (let p = 0; p < cells.length; p += perSheet) pages.push(`<div class="sheet">${cells.slice(p, p + perSheet).join('')}</div>`)
      body = pages.join('')
    } else {
      const rowsOf: string[] = []
      for (let p = 0; p < cells.length; p += paper.cols) rowsOf.push(`<div class="strip">${cells.slice(p, p + paper.cols).join('')}</div>`)
      body = rowsOf.join('')
    }
    win.document.write(`<!doctype html><title>Barcode labels</title><style>${LABEL_CSS}
      @page { size: ${paper.sheet ? 'A4' : `${paper.w * paper.cols}mm ${paper.h}mm`}; margin: 0 }
      body{margin:0}
      .sheet{width:${paper.w * paper.cols}mm;height:${paper.h * paper.rows}mm;margin:${paper.sheet ? `calc((297mm - ${paper.h * paper.rows}mm) / 2) auto 0` : '0'};display:grid;grid-template-columns:repeat(${paper.cols},${paper.w}mm);page-break-after:always;overflow:hidden}
      .strip{display:flex;page-break-after:always;width:${paper.w * paper.cols}mm;height:${paper.h}mm}
    </style>${body}`)
    win.document.close()
    win.focus()
    win.print()
  }

  const stat = (n: number, label: string) => (
    <div className="card" style={{ padding: '14px 18px', flex: '1 1 160px' }}><div style={{ fontSize: 22, fontWeight: 700 }}>{n}</div><div className="muted-sm">{label}</div></div>
  )
  const cats = [...new Set(all.map((i) => i.category).filter(Boolean) as string[])].sort()
  const comps = [...new Set(all.map((i) => i.make).filter(Boolean) as string[])].sort()

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <style>{LABEL_CSS}</style>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="muted-sm">{paper.sheet ? `A4 · ${perSheet} labels` : 'Label roll'} · {paper.sub} · {settings.kind === 'ean13' ? 'EAN-13' : 'Code 128'}</span>
        <button className="btn btn-sm" onClick={() => setOpen(true)}>Label settings</button>
        <button className="btn btn-primary" disabled={labels === 0} onClick={print}>Print labels</button>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {stat(listed.length, 'Items')}{stat(labels, 'Labels to print')}{stat(sheets, paper.sheet ? 'A4 sheets' : 'Sheets (roll)')}{stat(noBarcode, 'Without a saved barcode')}
      </div>
      {note && <p className="muted-sm" style={{ margin: 0 }}>{note}</p>}
      {items.error && <ErrorNote>{items.error}</ErrorNote>}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', gap: 14, alignItems: 'start' }}>
        <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="crm-bar itl-bar" style={{ flexWrap: 'wrap' }}>
            <b>Items <span className="muted-sm">({listed.length})</span></b>
            <select value={pick} onChange={(e) => { if (e.target.value) add([e.target.value]); setPick('') }} aria-label="Add an item" style={{ maxWidth: 260 }} className="crm-push">
              <option value="">Add an item — name, code or barcode</option>
              {all.filter((i) => copies[i.id] === undefined).map((i) => <option key={i.id} value={i.id}>{i.code} · {i.name}</option>)}
            </select>
            <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" style={{ maxWidth: 160 }}><option value="">Category</option>{cats.map((c) => <option key={c}>{c}</option>)}</select>
            <select value={company} onChange={(e) => setCompany(e.target.value)} aria-label="Company" style={{ maxWidth: 160 }}><option value="">Company</option>{comps.map((c) => <option key={c}>{c}</option>)}</select>
            <button className="btn btn-sm" disabled={!category && !company} onClick={() => add(all.filter((i) => (!category || i.category === category) && (!company || i.make === company)).map((i) => i.id))}>Add group</button>
            <button className="btn btn-sm" disabled={all.length === 0} onClick={() => add(all.map((i) => i.id))}>All items</button>
            {listed.length > 0 && <button className="btn btn-sm" onClick={() => setCopies({})}>Clear</button>}
          </div>
          {!items.data ? <Loading /> : listed.length === 0 ? (
            <EmptyState icon={<IconBuilding size={22} />} title="No items yet" body="Add one item above, a whole category or company, or every item at once." />
          ) : (
            <div className="table-wrap"><table className="itl">
              <thead><tr><th style={{ width: 36 }}>#</th><th>Item</th><th>Unit</th><th style={{ textAlign: 'right' }}>Sale rate</th><th style={{ textAlign: 'right' }}>Stock</th><th>Barcode no.</th><th>Bars</th><th style={{ width: 100 }}>Labels</th><th style={{ width: 32 }} /></tr></thead>
              <tbody>
                {listed.map((i, n) => (
                  <tr key={i.id}>
                    <td>{n + 1}</td><td><b>{i.name}</b><div className="muted-sm">{i.code}</div></td><td>{i.uom}</td>
                    <td style={{ textAlign: 'right' }}>{Number(i.sale_price) ? rupees(i.sale_price) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>{stock.get(i.id) ?? 0}</td>
                    <td className="itl-mono">{i.barcode ?? <span className="crm-muted">uses code</span>}</td>
                    <td><span style={{ display: 'inline-block', width: 90, height: 22 }} dangerouslySetInnerHTML={{ __html: barcodeSvg(i.barcode || i.code, settings.kind, 22).replace('<svg ', '<svg style="width:100%;height:100%" ') }} /></td>
                    <td><input value={copies[i.id] ? String(copies[i.id]) : ''} placeholder="0" inputMode="numeric" aria-label={`Labels of ${i.name}`} style={{ width: 80, textAlign: 'right' }}
                               onChange={(e) => setCopies((c) => ({ ...c, [i.id]: Math.min(999, Number(e.target.value.replace(/\D/g, '')) || 0) }))} /></td>
                    <td><button type="button" className="btn btn-sm" aria-label={`Remove ${i.name}`} onClick={() => setCopies((c) => { const { [i.id]: _gone, ...rest } = c; return rest })}>×</button></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </section>
        <aside className="card" style={{ padding: 14, display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><b>Label preview</b><button className="link-btn" onClick={() => setOpen(true)}>Change</button></div>
          <div style={{ background: 'var(--surface-2, #f3f4f6)', borderRadius: 8, padding: 12, display: 'grid', justifyItems: 'center' }}>
            <div style={{ transform: `scale(${Math.min(1, 250 / (paper.w * 3.78))})`, transformOrigin: 'top center', height: paper.h * 3.78 * Math.min(1, 250 / (paper.w * 3.78)) }}>
              <div style={{ width: `${paper.w}mm`, height: `${paper.h}mm`, border: '1px solid var(--border)' }} dangerouslySetInnerHTML={{ __html: labelHtml(sample, settings, firm, paper) }} />
            </div>
            <div className="muted-sm">{paper.w} × {paper.h} mm</div>
          </div>
          <p className="muted-sm" style={{ margin: 0 }}>{listed[0] ? `The label for ${listed[0].name}.` : 'A sample label — add an item to see its own.'}</p>
          <div className="muted-sm" style={{ display: 'grid', gap: 4 }}>
            <span>Label stock: <b>{paper.sheet ? `A4 · ${perSheet} labels` : 'Roll'} ({paper.sub})</b></span>
            <span>Barcode: <b>{settings.kind === 'ean13' ? 'EAN-13' : 'Code 128'}</b></span>
            {paper.sheet && <span>Starts at: <b>Label {settings.start} of {perSheet}</b></span>}
          </div>
          {paper.sheet && (
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${paper.cols}, 1fr)`, gap: 2, width: 90, justifySelf: 'center' }} aria-label="First sheet">
              {Array.from({ length: perSheet }, (_, n) => <span key={n} style={{ height: 6, border: '1px solid var(--border)', background: n + 1 < settings.start ? 'transparent' : n + 2 - settings.start <= labels ? 'var(--brand)' : 'transparent' }} />)}
            </div>
          )}
        </aside>
      </div>
      {open && <LabelSettingsDialog value={settings} sample={sample} firm={firm} onChange={change} onClose={() => setOpen(false)} />}
    </div>
  )
}

function LabelSettingsDialog({ value: s, sample, firm, onChange, onClose }: { value: LabelSettings; sample: LabelItem; firm: string; onChange: (p: Partial<LabelSettings>) => void; onClose: () => void }) {
  const paper = paperOf(s)
  const card = (p: Paper) => (
    <button key={p.key} type="button" className={`btn${!s.custom && s.paper === p.key ? ' btn-primary' : ''}`} style={{ display: 'grid', padding: '10px 14px', textAlign: 'center' }} onClick={() => onChange({ paper: p.key, custom: false })}>
      <b>{p.label}</b><span className="muted-sm" style={{ color: 'inherit', opacity: 0.8 }}>{p.sub}</span>
    </button>
  )
  const line = (k: 'header' | 'l1' | 'l2' | 'l3' | 'l4', label: string) => (
    <Field label={label}><select value={s[k]} onChange={(e) => onChange({ [k]: e.target.value } as Partial<LabelSettings>)}>{LINE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
  )
  const step = (n: number, title: string) => <h3 style={{ margin: '18px 0 8px', fontSize: 14 }}><span className="mh-card-badge">{n}</span> {title}</h3>
  return (
    <Dialog wide title="Label settings" subtitle="Paper, barcode and what each line of the label prints. Saved for next time." onClose={onClose}
            footer={<><button className="btn" onClick={() => onChange(DEFAULT_SETTINGS)}>Reset to default</button><button className="btn btn-primary crm-push" onClick={onClose}>Done</button></>}>
      <div style={{ overflowY: 'auto', minHeight: 0, flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 260px', gap: 18 }}>
        <div>
          {step(1, 'Paper')}
          <p className="muted-sm">A4 sticker sheet · any printer</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{PAPERS.filter((p) => p.sheet).map(card)}</div>
          <p className="muted-sm" style={{ marginTop: 12 }}>Label printer roll · TSC, Zebra, TVS…</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{PAPERS.filter((p) => !p.sheet).map(card)}</div>
          <p className="muted-sm" style={{ marginTop: 12 }}>Your own size · any sticker the shop already buys</p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className={`btn${s.custom ? ' btn-primary' : ''}`} onClick={() => onChange({ custom: true })}>Custom size</button>
            {s.custom && <>
              <input value={s.cw} inputMode="decimal" aria-label="Width in mm" style={{ width: 70 }} onChange={(e) => onChange({ cw: Math.max(20, Number(e.target.value.replace(/[^\d.]/g, '')) || 20) })} /> ×
              <input value={s.ch} inputMode="decimal" aria-label="Height in mm" style={{ width: 70 }} onChange={(e) => onChange({ ch: Math.max(15, Number(e.target.value.replace(/[^\d.]/g, '')) || 15) })} /> mm
            </>}
          </div>
          {step(2, 'Barcode')}
          <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
            <button type="button" className={`btn${s.kind === 'code128' ? ' btn-primary' : ''}`} onClick={() => onChange({ kind: 'code128' })}>Code 128 · letters and digits</button>
            <button type="button" className={`btn${s.kind === 'ean13' ? ' btn-primary' : ''}`} onClick={() => onChange({ kind: 'ean13' })}>EAN-13 · 13-digit retail</button>
            {paper.sheet && <Field label="Start at label no."><input value={s.start} inputMode="numeric" style={{ width: 90 }} onChange={(e) => onChange({ start: Math.min(paper.cols * paper.rows, Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1)) })} /></Field>}
          </div>
          {paper.sheet && <p className="muted-sm">Of {paper.cols * paper.rows}: skips stickers already used.</p>}
          {s.kind === 'ean13' && <p className="muted-sm">Items whose barcode is not 12 or 13 digits are printed as Code 128.</p>}
          <label className="crm-check"><input type="checkbox" checked={s.number} onChange={(e) => onChange({ number: e.target.checked })} /> Print the number under the bars</label>
          {step(3, 'Label lines')}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            {line('header', 'Header — top')}{line('l1', 'Line 1 — under number')}{line('l2', 'Line 2 — left')}{line('l3', 'Line 3 — right')}{line('l4', 'Line 4 — foot')}
          </div>
          <div style={{ display: 'flex', gap: 18, marginTop: 10 }}>
            <label className="crm-check"><input type="checkbox" checked={s.rupee} onChange={(e) => onChange({ rupee: e.target.checked })} /> ₹ before the rate</label>
            <label className="crm-check"><input type="checkbox" checked={s.captions} onChange={(e) => onChange({ captions: e.target.checked })} /> Captions — Rate, HSN</label>
          </div>
        </div>
        <div>
          <div className="muted-sm" style={{ marginBottom: 8 }}>LIVE PREVIEW</div>
          <div style={{ background: 'var(--surface-2, #f3f4f6)', borderRadius: 8, padding: 10, overflow: 'hidden' }}>
            <div style={{ transform: `scale(${Math.min(1, 230 / (paper.w * 3.78))})`, transformOrigin: 'top left', height: paper.h * 3.78 * Math.min(1, 230 / (paper.w * 3.78)) }}>
              <div style={{ width: `${paper.w}mm`, height: `${paper.h}mm`, border: '1px solid var(--border)' }} dangerouslySetInnerHTML={{ __html: labelHtml(sample, s, firm, paper) }} />
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
