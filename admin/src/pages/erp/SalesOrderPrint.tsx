/* The printed sales order: the invoice's A4 sheet and print stylesheet, with
 * what an order says rather than what an invoice says. The Download button and
 * the mail to the customer use the PDF in salesOrderPdf.ts. */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import '../../styles/invoice-print.css'
import { fetchImage } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { IconClose, IconDownload, IconPrinter } from '../../components/Icons'
import { crm } from '../crm/api'
import { amountInWords, useImage } from './InvoicePrint'
import { qtyText, rupees, type SalesOrder } from './api'

export const DELIVERY_MODES: [string, string][] = [
  ['courier', 'Courier'], ['transport', 'Transport / lorry'], ['hand', 'Hand delivery'], ['pickup', 'Customer pickup'], ['installation', 'Delivery & installation'],
]
export const FREIGHT_TERMS: [string, string][] = [['paid', 'Freight paid (by us)'], ['to_pay', 'Freight to pay (customer)'], ['included', 'Included in price']]

const longDate = (iso: string | null | undefined) =>
  iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : null
const num = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fileName = (so: SalesOrder) => `${so.number.replace(/[\\/:*?"<>|\s]+/g, '-')}.pdf`

/** An order that is not a commitment yet must say so on the paper. */
function watermark(so: SalesOrder): string | null {
  if (so.status === 'draft') return 'DRAFT'
  if (so.status === 'cancelled') return 'CANCELLED'
  if (so.status === 'submitted' || so.status === 'rejected') return 'NOT APPROVED'
  return null
}

/** The order's particulars, only those it actually has. */
function orderFacts(so: SalesOrder): Array<[string, string]> {
  const named = (list: [string, string][], key?: string | null) => list.find(([k]) => k === key)?.[1] ?? null
  const facts: Array<[string, string | null | undefined]> = [
    ['Order no.', so.number], ['Order date', longDate(so.order_date)], ['Delivery date', longDate(so.required_by)],
    ['Place of supply', so.place_of_supply], ['Payment terms', so.payment_terms], ['Customer PO', so.customer_po_number],
    ['PO date', longDate(so.customer_po_date)], ['Reference', so.reference], ['Salesperson', so.salesperson_name],
    ['Delivery mode', named(DELIVERY_MODES, so.delivery_mode)], ['Delivery terms', so.delivery_terms],
    ['Freight terms', named(FREIGHT_TERMS, so.freight_terms)], ['Transporter', so.transporter_name],
  ]
  return facts.filter((f): f is [string, string] => Boolean(f[1]))
}

/** Draw the PDF: the letterhead's images are fetched, and the PDF code loaded, only now. */
async function makePdf(so: SalesOrder) {
  const [{ buildSalesOrderPdf }, { imageData }, defaults] = await Promise.all([
    import('./salesOrderPdf'), import('./invoicePdf'), crm.quotationDefaults(),
  ])
  const s = defaults.setup ?? null
  const image = async (kind: 'logo' | 'stamp', present?: boolean) => {
    if (!present) return null
    const url = await fetchImage(`/api/v1/crm/settings/quotation-images/${kind}?v=${encodeURIComponent(s?.images_version ?? '')}`).catch(() => null)
    const data = await imageData(url)
    if (url) URL.revokeObjectURL(url)
    return data
  }
  const [logo, stamp] = await Promise.all([image('logo', s?.has_logo), image('stamp', s?.has_stamp)])
  return buildSalesOrderPdf({ so, setup: s, facts: orderFacts(so), mark: watermark(so), words: amountInWords, logo, stamp })
}

export async function downloadSalesOrderPdf(so: SalesOrder): Promise<void> {
  (await makePdf(so)).save(fileName(so))
}

/** The PDF as base64, for the mail to the customer. */
export async function salesOrderPdfBase64(so: SalesOrder): Promise<string> {
  return (await makePdf(so)).output('datauristring').split('base64,')[1]
}

export default function SalesOrderPrint({ so, onClose }: { so: SalesOrder; onClose: () => void }) {
  const defaults = useQuery('crm-quotation-defaults', () => crm.quotationDefaults())
  const s = defaults.data?.setup ?? null
  const logo = useImage('logo', s?.has_logo, s?.images_version)
  const stamp = useImage('stamp', s?.has_stamp, s?.images_version)
  const [making, setMaking] = useState(false)
  const [pdfError, setPdfError] = useState<string | null>(null)

  /** The page title becomes the suggested name when "Save as PDF" is picked. */
  function print() {
    const before = document.title
    document.title = fileName(so).replace(/\.pdf$/, '')
    window.print()
    document.title = before
  }

  async function download() {
    setMaking(true)
    setPdfError(null)
    try {
      await downloadSalesOrderPdf(so)
    } catch {
      setPdfError('The PDF could not be made. Use Print → Save as PDF instead.')
    } finally {
      setMaking(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    document.body.classList.add('ip-open')
    return () => { document.removeEventListener('keydown', onKey); document.body.classList.remove('ip-open') }
  }, [onClose])

  const company = s?.company_name || 'Your company'
  const inter = so.is_interstate
  const freight = Number(so.freight ?? 0)
  const other = Number(so.other_charges ?? 0)
  const discounted = so.lines.some((l) => Number(l.discount_percent ?? 0))
  const facts = orderFacts(so)
  const half = Math.ceil(facts.length / 2)
  const mark = watermark(so)
  const factList = (rows: Array<[string, string]>) => (
    <dl>{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className={k === 'Order no.' ? 'ip-strong' : undefined}>{v}</dd></div>)}</dl>
  )

  return createPortal(
    <div className="ip-backdrop" role="dialog" aria-modal="true" aria-label="Print sales order">
      <div className="ip-bar">
        <b>Sales order {so.number}</b>
        <span className="ip-gap" />
        {pdfError && <span className="error">{pdfError}</span>}
        <button className="btn" onClick={print}><IconPrinter size={15} /> Print</button>
        <button className="btn btn-primary" disabled={making} onClick={() => void download()}>
          <IconDownload size={15} /> {making ? 'Preparing PDF…' : 'Download PDF'}
        </button>
        <button className="btn" onClick={onClose}><IconClose size={15} /> Close</button>
      </div>
      <div className="ip-scroll">
        <article className="ip-sheet" style={s?.accent_color ? { ['--ip-accent' as string]: s.accent_color } : undefined}>
          {mark && <div className="ip-watermark">{mark}</div>}

          <header className="ip-head">
            <div className="ip-org">
              {logo && <img className="ip-logo" src={logo} alt="" />}
              <div>
                <div className="ip-org-name">{company}</div>
                {s?.tagline && <div className="ip-org-line ip-tagline">{s.tagline}</div>}
                {s?.address && <div className="ip-org-line ip-pre">{s.address}</div>}
                <div className="ip-org-line">{[s?.phone && `Ph: ${s.phone}`, s?.email, s?.website].filter(Boolean).join(' · ')}</div>
                <div className="ip-org-line">{[s?.gstin && `GSTIN: ${s.gstin}`, s?.pan && `PAN: ${s.pan}`, s?.cin && `CIN: ${s.cin}`].filter(Boolean).join(' · ')}</div>
              </div>
            </div>
            <div className="ip-title"><h1>Sales Order</h1></div>
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
              {so.place_of_supply && <p>State: {so.place_of_supply}</p>}
            </div>
            <div>
              <h4>Ship to</h4>
              <b>{so.customer_name}{so.site_name ? ` — ${so.site_name}` : ''}</b>
              <p className="ip-pre">{so.shipping_address || so.billing_address || '—'}</p>
              {so.delivery_instructions && <p className="ip-pre">Instructions: {so.delivery_instructions}</p>}
            </div>
          </section>

          <table className="ip-lines ip-paged">
            <colgroup>
              <col style={{ width: '5%' }} /><col /><col style={{ width: '11%' }} /><col style={{ width: '9%' }} />
              <col style={{ width: '10%' }} />{discounted && <col style={{ width: '7%' }} />}<col style={{ width: '11%' }} />
              <col style={{ width: '7%' }} /><col style={{ width: '12%' }} />
            </colgroup>
            <thead>
              <tr>
                <th>#</th><th className="ip-desc">Item &amp; description</th><th>HSN/SAC</th>
                <th className="ip-num">Qty</th><th className="ip-num">Rate</th>
                {discounted && <th className="ip-num">Disc.</th>}
                <th className="ip-num">Taxable</th><th className="ip-num">GST</th><th className="ip-num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {so.lines.map((l, i) => (
                <tr key={l.id}>
                  <td>{i + 1}</td>
                  <td className="ip-desc">{l.description}{l.item_code && <small> ({l.item_code})</small>}</td>
                  <td>{l.hsn_sac || '—'}</td>
                  <td className="ip-num">{qtyText(l.quantity)} {l.uom}</td>
                  <td className="ip-num">{num(l.rate)}</td>
                  {discounted && <td className="ip-num">{Number(l.discount_percent ?? 0)}%</td>}
                  <td className="ip-num">{num(l.taxable_value)}</td>
                  <td className="ip-num">{Number(l.gst_percent ?? 0)}%</td>
                  <td className="ip-num ip-strong">{num(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <section className="ip-sums">
            <div className="ip-left">
              <p className="ip-words"><b>Amount in words:</b> {amountInWords(Number(so.grand_total))}</p>
            </div>
            <dl className="ip-totals">
              {(freight > 0 || other > 0) && <div><dt>Items</dt><dd>{num(Number(so.sub_total) - freight - other)}</dd></div>}
              {freight > 0 && <div><dt>Freight charges</dt><dd>{num(freight)}</dd></div>}
              {other > 0 && <div><dt>Other charges</dt><dd>{num(other)}</dd></div>}
              <div><dt>Taxable amount</dt><dd>{num(so.sub_total)}</dd></div>
              {inter
                ? <div><dt>IGST</dt><dd>{num(so.igst)}</dd></div>
                : <><div><dt>CGST</dt><dd>{num(so.cgst)}</dd></div><div><dt>SGST</dt><dd>{num(so.sgst)}</dd></div></>}
              <div className="ip-grand"><dt>Total</dt><dd>{rupees(so.grand_total)}</dd></div>
            </dl>
          </section>

          <section className="ip-foot">
            <div className="ip-foot-left">
              {so.notes && <div><h4>Notes</h4><p className="ip-pre">{so.notes}</p></div>}
              {(so.terms || s?.footer) && <div><h4>Terms &amp; conditions</h4><p className="ip-pre">{so.terms || s?.footer}</p></div>}
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
