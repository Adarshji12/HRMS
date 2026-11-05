/* The printed purchase order: the invoice's A4 sheet and print stylesheet, with
 * what an order to a vendor says. The Download button and the mail to the vendor
 * use the PDF in purchaseOrderPdf.ts. */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import '../../styles/invoice-print.css'
import { fetchImage } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { IconClose, IconDownload, IconPrinter } from '../../components/Icons'
import { crm } from '../crm/api'
import { amountInWords, useImage } from './InvoicePrint'
import { qtyText, rupees, type PurchaseOrder } from './api'

const longDate = (iso: string | null | undefined) =>
  iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : null
const num = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fileName = (po: PurchaseOrder) => `${po.number.replace(/[\\/:*?"<>|\s]+/g, '-')}.pdf`

/** An order that is not a commitment yet must say so on the paper. */
function watermark(po: PurchaseOrder): string | null {
  if (po.status === 'draft') return 'DRAFT'
  if (po.status === 'cancelled') return 'CANCELLED'
  if (po.status === 'submitted' || po.status === 'rejected') return 'NOT APPROVED'
  return null
}

/** The order's particulars, only those it actually has. */
function orderFacts(po: PurchaseOrder): Array<[string, string]> {
  const facts: Array<[string, string | null | undefined]> = [
    ['PO no.', po.revision > 0 ? `${po.number} (rev ${po.revision})` : po.number], ['PO date', longDate(po.order_date)],
    ['Expected delivery', longDate(po.committed_date ?? po.expected_date)], ['Payment terms', po.payment_terms],
    ['Delivery terms', po.delivery_terms], ['Vendor quotation', po.vendor_quote_ref],
    ['Quotation date', longDate(po.vendor_quote_date)], ['Company / make', po.company], ['Contact person', po.contact_person],
  ]
  return facts.filter((f): f is [string, string] => Boolean(f[1]))
}

function ldClause(po: PurchaseOrder): string | null {
  const rate = Number(po.ld_percent_per_week)
  if (!(rate > 0)) return null
  const cap = Number(po.ld_cap_percent)
  return `Liquidated damages of ${rate}% per week apply on the value delivered late${cap > 0 ? `, up to ${cap}% of that value` : ''}.`
}

/** Draw the PDF: the letterhead's images are fetched, and the PDF code loaded, only now. */
async function makePdf(po: PurchaseOrder) {
  const [{ buildPurchaseOrderPdf }, { imageData }, defaults] = await Promise.all([
    import('./purchaseOrderPdf'), import('./invoicePdf'), crm.quotationDefaults(),
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
  return buildPurchaseOrderPdf({ po, setup: s, facts: orderFacts(po), mark: watermark(po), clause: ldClause(po), words: amountInWords, logo, stamp })
}

export async function downloadPurchaseOrderPdf(po: PurchaseOrder): Promise<void> {
  (await makePdf(po)).save(fileName(po))
}

/** The PDF as base64, for the mail to the vendor. */
export async function purchaseOrderPdfBase64(po: PurchaseOrder): Promise<string> {
  return (await makePdf(po)).output('datauristring').split('base64,')[1]
}

export default function PurchaseOrderPrint({ po, onClose }: { po: PurchaseOrder; onClose: () => void }) {
  const defaults = useQuery('crm-quotation-defaults', () => crm.quotationDefaults())
  const s = defaults.data?.setup ?? null
  const logo = useImage('logo', s?.has_logo, s?.images_version)
  const stamp = useImage('stamp', s?.has_stamp, s?.images_version)
  const [making, setMaking] = useState(false)
  const [pdfError, setPdfError] = useState<string | null>(null)

  /** The page title becomes the suggested name when "Save as PDF" is picked. */
  function print() {
    const before = document.title
    document.title = fileName(po).replace(/\.pdf$/, '')
    window.print()
    document.title = before
  }

  async function download() {
    setMaking(true)
    setPdfError(null)
    try {
      await downloadPurchaseOrderPdf(po)
    } catch {
      setPdfError('The PDF could not be made. Use Print → Save as PDF instead.')
    } finally {
      setMaking(false)
    }
  }

  useEffect(() => {
    // Stopped here: the order's detail view behind this listens for Escape too.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('keydown', onKey)
    document.body.classList.add('ip-open')
    return () => { document.removeEventListener('keydown', onKey); document.body.classList.remove('ip-open') }
  }, [onClose])

  const company = s?.company_name || 'Your company'
  const inter = po.is_interstate
  const freight = Number(po.freight ?? 0)
  const other = Number(po.other_charges ?? 0)
  const discounted = po.lines.some((l) => Number(l.discount_percent ?? 0))
  const dated = po.lines.some((l) => l.expected_date)
  const facts = orderFacts(po)
  const half = Math.ceil(facts.length / 2)
  const mark = watermark(po)
  const clause = ldClause(po)
  const billTo = po.billing_address || s?.address
  const factList = (rows: Array<[string, string]>) => (
    <dl>{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className={k === 'PO no.' ? 'ip-strong' : undefined}>{v}</dd></div>)}</dl>
  )

  return createPortal(
    <div className="ip-backdrop" role="dialog" aria-modal="true" aria-label="Print purchase order">
      <div className="ip-bar">
        <b>Purchase order {po.number}</b>
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
            <div className="ip-title"><h1>Purchase Order</h1></div>
          </header>

          <section className="ip-meta">
            {factList(facts.slice(0, half))}
            {factList(facts.slice(half))}
          </section>

          <section className="ip-parties pop-parties">
            <div>
              <h4>Vendor</h4>
              <b>{po.vendor_name}</b>
              {po.vendor_address && <p className="ip-pre">{po.vendor_address}</p>}
              <p>GSTIN: {po.vendor_gstin || 'Unregistered'}</p>
              {po.vendor_state && <p>State: {po.vendor_state}</p>}
              {(po.vendor_contact || po.vendor_phone || po.vendor_email) && <p>{[po.vendor_contact, po.vendor_phone, po.vendor_email].filter(Boolean).join(' · ')}</p>}
            </div>
            <div>
              <h4>Bill to</h4>
              <b>{company}</b>
              {billTo && <p className="ip-pre">{billTo}</p>}
              {s?.gstin && <p>GSTIN: {s.gstin}</p>}
            </div>
            <div>
              <h4>Ship to</h4>
              <b>{po.warehouse_name ?? company}</b>
              {po.warehouse_name ? po.warehouse_address && <p className="ip-pre">{po.warehouse_address}</p> : billTo && <p className="ip-pre">{billTo}</p>}
            </div>
          </section>

          <table className="ip-lines ip-paged">
            <colgroup>
              <col style={{ width: '4%' }} /><col /><col style={{ width: '10%' }} /><col style={{ width: '8%' }} />
              <col style={{ width: '9%' }} />{discounted && <col style={{ width: '6%' }} />}<col style={{ width: '10%' }} />
              <col style={{ width: '6%' }} />{dated && <col style={{ width: '10%' }} />}<col style={{ width: '11%' }} />
            </colgroup>
            <thead>
              <tr>
                <th>#</th><th className="ip-desc">Item &amp; description</th><th>HSN/SAC</th>
                <th className="ip-num">Qty</th><th className="ip-num">Rate</th>
                {discounted && <th className="ip-num">Disc.</th>}
                <th className="ip-num">Taxable</th><th className="ip-num">GST</th>
                {dated && <th>Delivery</th>}
                <th className="ip-num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {po.lines.map((l, i) => (
                <tr key={l.id}>
                  <td>{i + 1}</td>
                  <td className="ip-desc">{l.description}{l.item_code && <small> ({l.item_code})</small>}</td>
                  <td>{l.hsn_sac || '—'}</td>
                  <td className="ip-num">{qtyText(l.quantity)} {l.uom}</td>
                  <td className="ip-num">{num(l.rate)}</td>
                  {discounted && <td className="ip-num">{Number(l.discount_percent ?? 0)}%</td>}
                  <td className="ip-num">{num(l.taxable_value)}</td>
                  <td className="ip-num">{Number(l.gst_percent ?? 0)}%</td>
                  {dated && <td>{longDate(l.expected_date) ?? '—'}</td>}
                  <td className="ip-num ip-strong">{num(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <section className="ip-sums">
            <div className="ip-left">
              <p className="ip-words"><b>Amount in words:</b> {amountInWords(Number(po.grand_total))}</p>
            </div>
            <dl className="ip-totals">
              <div><dt>Taxable amount</dt><dd>{num(po.sub_total)}</dd></div>
              {inter
                ? <div><dt>IGST</dt><dd>{num(po.igst)}</dd></div>
                : <><div><dt>CGST</dt><dd>{num(po.cgst)}</dd></div><div><dt>SGST</dt><dd>{num(po.sgst)}</dd></div></>}
              {freight > 0 && <div><dt>Freight charges</dt><dd>{num(freight)}</dd></div>}
              {other > 0 && <div><dt>Other charges</dt><dd>{num(other)}</dd></div>}
              <div className="ip-grand"><dt>Total</dt><dd>{rupees(po.grand_total)}</dd></div>
            </dl>
          </section>

          <section className="ip-foot">
            <div className="ip-foot-left">
              {po.notes && <div><h4>Notes</h4><p className="ip-pre">{po.notes}</p></div>}
              {clause && <div><h4>Late delivery</h4><p>{clause}</p></div>}
              {po.terms && <div><h4>Terms &amp; conditions</h4><p className="ip-pre">{po.terms}</p></div>}
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
