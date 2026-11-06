/* The RFQ as a vendor receives it: what to quote on, by when, and on what
 * terms, with blank rate and amount columns to fill in. The buyer's target
 * rates and internal notes never appear. Saved as a PDF through the browser. */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import '../../styles/invoice-print.css'
import { useQuery } from '../../lib/useQuery'
import { IconClose, IconPrinter } from '../../components/Icons'
import { crm } from '../crm/api'
import { useImage } from './InvoicePrint'
import { qtyText, type Rfq } from './api'

const day = (iso: string | null | undefined) => {
  if (!iso) return '—'
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function RfqPrint({ rfq, onClose }: { rfq: Rfq; onClose: () => void }) {
  const defaults = useQuery('crm-quotation-defaults', () => crm.quotationDefaults())
  const s = defaults.data?.setup ?? null
  const logo = useImage('logo', s?.has_logo, s?.images_version)
  const stamp = useImage('stamp', s?.has_stamp, s?.images_version)
  const company = s?.company_name || 'Your company'
  // One copy per vendor: the letter is addressed to whoever it goes to.
  const [vendorId, setVendorId] = useState(rfq.vendors[0]?.vendor_id ?? '')
  const vendor = rfq.vendors.find((v) => v.vendor_id === vendorId) ?? null

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    document.body.classList.add('ip-open')
    return () => { document.removeEventListener('keydown', onKey); document.body.classList.remove('ip-open') }
  }, [onClose])

  function print() {
    const before = document.title
    document.title = `RFQ ${rfq.number}${vendor ? ` ${vendor.legal_name}` : ''}`.replace(/[/\\]/g, '-')
    window.print()
    document.title = before
  }

  const facts: Array<[string, string]> = [
    ['RFQ no.', rfq.number],
    ['RFQ date', day(rfq.rfq_date ?? rfq.created_at)],
    ['Quotes due by', day(rfq.due_date)],
    ['Goods needed by', day(rfq.required_by)],
    ['Payment terms', rfq.payment_terms ?? 'As offered'],
    ['Delivery terms', rfq.delivery_terms ?? 'As offered'],
    ['Quote validity', rfq.quote_validity_days ? `${rfq.quote_validity_days} days` : 'As offered'],
    ['Contact', rfq.contact_person ?? rfq.created_by_name ?? '—'],
  ]
  const half = Math.ceil(facts.length / 2)
  const factList = (rows: Array<[string, string]>) => (
    <dl>{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className={k === 'RFQ no.' ? 'ip-strong' : undefined}>{v}</dd></div>)}</dl>
  )

  return createPortal(
    <div className="ip-backdrop" role="dialog" aria-modal="true" aria-label="Print RFQ">
      <div className="ip-bar">
        <b>RFQ {rfq.number}</b>
        {rfq.vendors.length > 1 && (
          <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} aria-label="Addressed to" style={{ height: 34, maxWidth: 260 }}>
            {rfq.vendors.map((v) => <option key={v.vendor_id} value={v.vendor_id}>To {v.legal_name}</option>)}
          </select>
        )}
        <span className="ip-gap" />
        <button className="btn btn-primary" onClick={print}><IconPrinter size={15} /> Print / Save as PDF</button>
        <button className="btn" onClick={onClose}><IconClose size={15} /> Close</button>
      </div>
      <div className="ip-scroll">
        <article className="ip-sheet" style={s?.accent_color ? { ['--ip-accent' as string]: s.accent_color } : undefined}>
          {rfq.status === 'cancelled' && <div className="ip-watermark">CANCELLED</div>}

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
            <div className="ip-title"><h1>Request for Quotation</h1></div>
          </header>

          <section className="ip-meta">
            {factList(facts.slice(0, half))}
            {factList(facts.slice(half))}
          </section>

          <section className="ip-parties">
            <div>
              <h4>To</h4>
              <b>{vendor?.legal_name ?? '______________________'}</b>
              {vendor?.address && <p className="ip-pre">{vendor.address}</p>}
              {vendor && <p>{[vendor.contact_name && `Attn: ${vendor.contact_name}`, vendor.phone, vendor.email].filter(Boolean).join(' · ')}</p>}
              {vendor?.gstin && <p>GSTIN: {vendor.gstin}</p>}
            </div>
            <div>
              <h4>Deliver to</h4>
              <b>{rfq.warehouse_name ?? company}</b>
              <p>Subject: {rfq.title}</p>
            </div>
          </section>

          <p className="ip-words" style={{ margin: '0 0 10px' }}>
            Please quote your best price for the items below{rfq.due_date ? ` by ${day(rfq.due_date)}` : ''}, with make and model, GST rate, delivery period, warranty and the validity of your offer.
          </p>

          <table className="ip-lines ip-paged">
            <colgroup><col style={{ width: '5%' }} /><col /><col style={{ width: '12%' }} /><col style={{ width: '15%' }} /><col style={{ width: '16%' }} /></colgroup>
            <thead>
              <tr><th>#</th><th className="ip-desc">Item &amp; specification</th><th className="ip-num">Qty</th><th className="ip-num">Rate (₹)</th><th className="ip-num">Amount (₹)</th></tr>
            </thead>
            <tbody>
              {rfq.lines.map((l, i) => (
                <tr key={l.id}>
                  <td>{i + 1}</td>
                  <td className="ip-desc">
                    {l.description}{l.item_code && <small> ({l.item_code})</small>}
                    {l.specification && <small style={{ display: 'block' }}>{l.specification}</small>}
                  </td>
                  <td className="ip-num">{qtyText(l.quantity)} {l.uom}</td>
                  <td className="ip-num" />
                  <td className="ip-num" />
                </tr>
              ))}
            </tbody>
          </table>

          {rfq.terms && (
            <section className="ip-sums">
              <div className="ip-left">
                <p className="ip-words"><b>Terms and instructions</b></p>
                <p className="ip-pre" style={{ margin: 0, fontSize: 12 }}>{rfq.terms}</p>
              </div>
            </section>
          )}

          <section className="ip-foot">
            <div className="ip-sign">
              <div>Vendor's seal and signature</div>
              <div className="ip-stamp" />
              <div className="ip-sign-line">Name, signature and date</div>
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
