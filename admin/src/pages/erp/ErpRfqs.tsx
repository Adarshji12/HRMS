/* RFQs — several vendors quote, the comparison ranks them on landed cost, one
 * is awarded, and the award becomes a draft purchase order.
 *
 * Choosing anything but the cheapest landed quote — or awarding the only quote
 * received — asks for a reason, because the server will (PRD FR-06.07). */

import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '../../lib/useQuery'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconSheet } from '../../components/Icons'
import { erp, erpError, qtyText, rupees, type Comparison, type Rfq } from './api'
import { DateText, Dialog, Drawer, ErpPage, ErpState, Facts, Field, Note, ReasonDialog, useAccess, useRun } from './parts'

export default function ErpRfqs() {
  const list = useQuery('erp-rfqs', () => erp.rfqs())
  const [params, setParams] = useSearchParams()
  const [openId, setOpenId] = useState<string | null>(params.get('open'))
  useEffect(() => { if (params.get('open')) { setOpenId(params.get('open')); setParams({}, { replace: true }) } }, [params, setParams])

  return (
    <ErpPage title="Requests for quotation" subtitle="Several vendors quote; the comparison ranks them on landed cost. Raise one from an approved requisition.">
      {list.error && <ErrorNote>{erpError(list.cause, 'Could not load RFQs')}</ErrorNote>}
      <section className="card">
        {!list.data ? <Loading /> : list.data.length === 0 ? (
          <EmptyState icon={<IconSheet size={22} />} title="No RFQs yet" body="Open an approved requisition and choose “Request quotes”." />
        ) : (
          <div className="table-wrap"><table>
            <thead><tr><th>Number</th><th>Title</th><th>Due</th><th>Vendors</th><th>Quotes</th><th>Status</th></tr></thead>
            <tbody>{list.data.map((r) => (
              <tr key={r.id} onClick={() => setOpenId(r.id)} style={{ cursor: 'pointer' }}>
                <td className="crm-strong">{r.number}</td><td>{r.title}</td><td><DateText iso={r.due_date} /></td>
                <td>{r.vendors.length}</td><td>{r.vendors.filter((v) => v.quoted).length}</td><td><ErpState value={r.status} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {openId && <RfqDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => list.reload()} />}
    </ErpPage>
  )
}

function RfqDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const navigate = useNavigate()
  const { can } = useAccess()
  const rfq = useQuery(`erp-rfq-${id}`, () => erp.rfq(id))
  const cmp = useQuery(`erp-rfq-cmp-${id}`, () => erp.comparison(id), { enabled: Boolean(rfq.data?.quotes.length) })
  const { busy, error, run } = useRun(() => { rfq.reload(); cmp.reload(); onChanged() })
  const [quoting, setQuoting] = useState<string | null>(null)
  const [award, setAward] = useState<Comparison['quotes'][number] | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const r = rfq.data
  if (!r) return <Drawer title="RFQ" onClose={onClose}><Loading /></Drawer>
  const mine = can('can_manage_procurement')

  return (
    <Drawer title={`${r.number} · ${r.title}`} meta={<ErpState value={r.status} />} onClose={onClose} footer={
      <div className="crm-row-actions">
        {error && <span className="error">{error}</span>}
        {mine && r.status === 'draft' && <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => erp.issueRfq(r.id))}>Issue to vendors</button>}
        {mine && r.status === 'awarded' && (
          <button className="btn btn-primary" disabled={busy} onClick={() => void run(async () => {
            const po = await erp.rfqToPo(r.id)
            navigate(`/erp/purchase-orders?open=${po.id}`)
          })}>Raise purchase order</button>
        )}
        {mine && ['draft', 'issued'].includes(r.status) && <button className="btn" onClick={() => setCancelling(true)}>Cancel RFQ</button>}
      </div>
    }>
      {r.award_reason && <Note tone="ok">Award reason: {r.award_reason}</Note>}
      <Facts items={[['Due', <DateText iso={r.due_date} />], ['Lines', r.lines.length], ['Vendors invited', r.vendors.length]]} />
      <h4 className="crm-panel-title">Vendors</h4>
      {r.vendors.map((v) => (
        <div key={v.vendor_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
          <span style={{ flex: 1 }}>{v.legal_name} <span className="crm-sub">{v.code}</span></span>
          {v.quoted ? <ErpState value="received" /> : <span className="crm-muted">awaiting</span>}
          {mine && r.status === 'issued' && <button className="btn btn-sm" onClick={() => setQuoting(v.vendor_id)}>{v.quoted ? 'New round' : 'Record quote'}</button>}
        </div>
      ))}

      {cmp.data && cmp.data.quotes.length > 0 && (
        <>
          <h4 className="crm-panel-title" style={{ marginTop: 16 }}>Comparison</h4>
          <div className="table-wrap"><table>
            <thead>
              <tr><th>Line</th>{cmp.data.quotes.map((q) => <th key={q.id} className="crm-num">{q.vendor_name}{q.round > 1 ? ` (R${q.round})` : ''}</th>)}</tr>
            </thead>
            <tbody>
              {cmp.data.lines.map((line) => (
                <tr key={line.id}>
                  <td>{line.description} <span className="crm-sub">× {qtyText(line.quantity)}</span></td>
                  {cmp.data!.quotes.map((q) => {
                    const cell = line.rates[q.id]
                    const best = cell && line.lowest_rate && Number(cell.rate) === Number(line.lowest_rate)
                    return <td key={q.id} className="crm-num" style={best ? { color: 'var(--status-good)', fontWeight: 600 } : undefined}>{cell ? rupees(cell.rate) : '—'}</td>
                  })}
                </tr>
              ))}
              <tr><td className="crm-sub">Freight</td>{cmp.data.quotes.map((q) => <td key={q.id} className="crm-num">{rupees(q.freight)}</td>)}</tr>
              <tr><td className="crm-sub">Delivery / terms</td>{cmp.data.quotes.map((q) => <td key={q.id} className="crm-num crm-sub">{q.delivery_days ?? '—'} d · {q.payment_terms ?? '—'}</td>)}</tr>
              <tr><td className="crm-strong">Landed total</td>{cmp.data.quotes.map((q) => (
                <td key={q.id} className="crm-num crm-strong">{rupees(q.landed_total)} <span className="crm-sub">#{q.rank}</span></td>
              ))}</tr>
              {mine && r.status === 'issued' && (
                <tr><td />{cmp.data.quotes.map((q) => (
                  <td key={q.id} className="crm-num"><button className="btn btn-sm btn-primary" onClick={() => setAward(q)}>Award</button></td>
                ))}</tr>
              )}
            </tbody>
          </table></div>
        </>
      )}

      {quoting && <QuoteForm rfq={r} vendorId={quoting} onClose={() => setQuoting(null)} onSaved={() => { setQuoting(null); rfq.reload(); cmp.reload() }} />}
      {award && (
        award.is_lowest && cmp.data!.quotes.length > 1 ? (
          <Dialog title={`Award to ${award.vendor_name}?`} subtitle={`Lowest landed cost: ${rupees(award.landed_total)}`} onClose={() => setAward(null)} footer={
            <>
              <button className="btn" onClick={() => setAward(null)}>Back</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => void run(async () => { await erp.award(r.id, award.id); setAward(null) })}>Award</button>
            </>
          }><div style={{ padding: '0 20px 12px' }} /></Dialog>
        ) : (
          <ReasonDialog title={`Award to ${award.vendor_name}`} confirm="Award"
            hint={cmp.data!.quotes.length === 1 ? 'Only one quote was received — say why that is acceptable.' : 'This is not the lowest landed cost — say why it wins.'}
            onClose={() => setAward(null)} onSubmit={async (reason) => { await erp.award(r.id, award.id, reason); rfq.reload(); cmp.reload(); onChanged() }} />
        )
      )}
      {cancelling && <ReasonDialog title={`Cancel ${r.number}`} danger onClose={() => setCancelling(false)}
        onSubmit={async (reason) => { await erp.cancelRfq(r.id, reason); rfq.reload(); onChanged() }} />}
    </Drawer>
  )
}

function QuoteForm({ rfq, vendorId, onClose, onSaved }: { rfq: Rfq; vendorId: string; onClose: () => void; onSaved: () => void }) {
  const vendor = rfq.vendors.find((v) => v.vendor_id === vendorId)
  const [rates, setRates] = useState<Record<string, { rate: string; gst: string }>>(
    Object.fromEntries(rfq.lines.map((l) => [l.id, { rate: '', gst: '18' }])))
  const [meta, setMeta] = useState({ quote_ref: '', valid_until: '', delivery_days: '', payment_terms: '', warranty: '', freight: '0' })
  const { busy, error, run } = useRun()
  return (
    <Dialog wide title={`Quote from ${vendor?.legal_name ?? 'vendor'}`} subtitle="Enter 0 for a line the vendor did not offer." onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void run(async () => {
          await erp.addQuote(rfq.id, {
            vendor_id: vendorId, ...meta, delivery_days: meta.delivery_days ? Number(meta.delivery_days) : null,
            valid_until: meta.valid_until || null,
            lines: rfq.lines.map((l) => ({ rfq_line_id: l.id, rate: rates[l.id].rate || '0', gst_percent: rates[l.id].gst || '0' })),
          })
          onSaved()
        })}>Save quote</button>
      </>
    }>
      <div style={{ padding: '0 20px 12px' }}>
        <div className="table-wrap"><table className="crm-lines">
          <thead><tr><th>Line</th><th className="crm-num">Qty</th><th className="crm-num">Rate</th><th className="crm-num">GST %</th></tr></thead>
          <tbody>{rfq.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.description}</td><td className="crm-num">{qtyText(l.quantity)}</td>
              <td className="crm-line-rate"><input inputMode="decimal" value={rates[l.id].rate} onChange={(e) => setRates({ ...rates, [l.id]: { ...rates[l.id], rate: e.target.value } })} /></td>
              <td className="crm-line-gst"><input inputMode="decimal" value={rates[l.id].gst} onChange={(e) => setRates({ ...rates, [l.id]: { ...rates[l.id], gst: e.target.value } })} /></td>
            </tr>
          ))}</tbody>
        </table></div>
        <div className="crm-form" style={{ marginTop: 12 }}>
          <Field label="Vendor quote ref"><input value={meta.quote_ref} onChange={(e) => setMeta({ ...meta, quote_ref: e.target.value })} /></Field>
          <Field label="Valid until"><input type="date" value={meta.valid_until} onChange={(e) => setMeta({ ...meta, valid_until: e.target.value })} /></Field>
          <Field label="Delivery (days)"><input inputMode="numeric" value={meta.delivery_days} onChange={(e) => setMeta({ ...meta, delivery_days: e.target.value })} /></Field>
          <Field label="Freight"><input inputMode="decimal" value={meta.freight} onChange={(e) => setMeta({ ...meta, freight: e.target.value })} /></Field>
          <Field label="Payment terms"><input value={meta.payment_terms} onChange={(e) => setMeta({ ...meta, payment_terms: e.target.value })} /></Field>
          <Field label="Warranty"><input value={meta.warranty} onChange={(e) => setMeta({ ...meta, warranty: e.target.value })} /></Field>
        </div>
      </div>
    </Dialog>
  )
}
