/* The delivery challan that travels with a dispatch: what left, for whom and how,
 * with room for the receiver to sign. No prices per line: it is a transport
 * document, not a bill. Saved as a PDF through the browser's print dialog. */

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import '../../styles/invoice-print.css'
import { useQuery } from '../../lib/useQuery'
import { IconClose, IconPrinter } from '../../components/Icons'
import { crm } from '../crm/api'
import { useImage } from './InvoicePrint'
import { qtyText, rupees, type SalesOrderDetail } from './api'

type Dispatch = SalesOrderDetail['dispatch_details'][number]

const day = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function DispatchChallan({ so, dispatch, onClose }: { so: SalesOrderDetail; dispatch: Dispatch; onClose: () => void }) {
  const defaults = useQuery('crm-quotation-defaults', () => crm.quotationDefaults())
  const s = defaults.data?.setup ?? null
  const logo = useImage('logo', s?.has_logo, s?.images_version)
  const stamp = useImage('stamp', s?.has_stamp, s?.images_version)
  const company = s?.company_name || 'Your company'

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    document.body.classList.add('ip-open')
    return () => { document.removeEventListener('keydown', onKey); document.body.classList.remove('ip-open') }
  }, [onClose])

  function print() {
    const before = document.title
    document.title = `Challan ${dispatch.number}`.replace(/[/\\]/g, '-')
    window.print()
    document.title = before
  }

  const lineOf = (id: string) => so.lines.find((l) => l.id === id)
  const facts: Array<[string, string]> = [
    ['Challan no.', dispatch.number],
    ['Date', day(dispatch.dispatch_date)],
    ['Sales order', so.number],
    ...(so.customer_po_number ? [['Customer PO', so.customer_po_number] as [string, string]] : []),
    ['From warehouse', dispatch.warehouse ?? '—'],
    ['Transporter', dispatch.transporter ?? '—'],
    ['Vehicle no.', dispatch.vehicle_no ?? '—'],
    ['LR / tracking', dispatch.tracking_ref ?? '—'],
    ...(dispatch.eway_bill_no ? [['E-way bill', dispatch.eway_bill_no] as [string, string]] : []),
  ]
  const half = Math.ceil(facts.length / 2)
  const factList = (rows: Array<[string, string]>) => (
    <dl>{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className={k === 'Challan no.' ? 'ip-strong' : undefined}>{v}</dd></div>)}</dl>
  )

  return createPortal(
    <div className="ip-backdrop" role="dialog" aria-modal="true" aria-label="Print delivery challan">
      <div className="ip-bar">
        <b>Delivery challan {dispatch.number}</b>
        <span className="ip-gap" />
        <button className="btn btn-primary" onClick={print}><IconPrinter size={15} /> Print / Save as PDF</button>
        <button className="btn" onClick={onClose}><IconClose size={15} /> Close</button>
      </div>
      <div className="ip-scroll">
        <article className="ip-sheet" style={s?.accent_color ? { ['--ip-accent' as string]: s.accent_color } : undefined}>
          {dispatch.status === 'cancelled' && <div className="ip-watermark">CANCELLED</div>}

          <header className="ip-head">
            <div className="ip-org">
              {logo && <img className="ip-logo" src={logo} alt="" />}
              <div>
                <div className="ip-org-name">{company}</div>
                {s?.address && <div className="ip-org-line ip-pre">{s.address}</div>}
                <div className="ip-org-line">{[s?.phone && `Ph: ${s.phone}`, s?.email].filter(Boolean).join(' · ')}</div>
                <div className="ip-org-line">{s?.gstin ? `GSTIN: ${s.gstin}` : ''}</div>
              </div>
            </div>
            <div className="ip-title"><h1>Delivery Challan</h1></div>
          </header>

          <section className="ip-meta">
            {factList(facts.slice(0, half))}
            {factList(facts.slice(half))}
          </section>

          <section className="ip-parties">
            <div>
              <h4>Bill to</h4>
              <b>{so.customer_name}</b>
              {so.billing_address && <p className="ip-pre">{so.billing_address}</p>}
              <p>GSTIN: {so.customer_gstin || 'Unregistered'}</p>
            </div>
            <div>
              <h4>Ship to</h4>
              <b>{so.customer_name}{so.site_name ? ` — ${so.site_name}` : ''}</b>
              <p className="ip-pre">{dispatch.ship_to || so.shipping_address || so.billing_address || '—'}</p>
              {so.delivery_instructions && <p className="ip-pre">Instructions: {so.delivery_instructions}</p>}
            </div>
          </section>

          <table className="ip-lines ip-paged">
            <colgroup><col style={{ width: '6%' }} /><col /><col style={{ width: '14%' }} /><col style={{ width: '14%' }} /></colgroup>
            <thead>
              <tr><th>#</th><th className="ip-desc">Item &amp; description</th><th>HSN/SAC</th><th className="ip-num">Qty</th></tr>
            </thead>
            <tbody>
              {dispatch.lines.map((l, i) => {
                const line = lineOf(l.order_line_id)
                return (
                  <tr key={l.id}>
                    <td>{i + 1}</td>
                    <td className="ip-desc">
                      {l.description}{line?.item_code && <small> ({line.item_code})</small>}
                      {l.serials.length > 0 && <small style={{ display: 'block' }}>Serials: {l.serials.join(', ')}</small>}
                    </td>
                    <td>{line?.hsn_sac || '—'}</td>
                    <td className="ip-num">{qtyText(l.quantity)} {line?.uom ?? ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          <section className="ip-sums">
            <div className="ip-left">
              <p className="ip-words"><b>Value of goods:</b> {rupees(dispatch.value)} before GST, for transport only. This is not a tax invoice.</p>
            </div>
          </section>

          <section className="ip-foot">
            <div className="ip-sign">
              <div>Received in good condition</div>
              <div className="ip-stamp" />
              <div className="ip-sign-line">Receiver's name, signature and date</div>
            </div>
            <div className="ip-sign">
              <div>For <b>{company}</b></div>
              <div className="ip-stamp">{stamp && <img src={stamp} alt="" />}</div>
              <div className="ip-sign-line">{s?.signatory || 'Authorised signatory'}</div>
            </div>
          </section>
        </article>
      </div>
    </div>,
    document.body,
  )
}
