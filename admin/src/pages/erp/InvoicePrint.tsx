/* The invoice as it is printed — an A4 GST tax invoice.
 *
 * The letterhead (company name, address, GSTIN, logo, stamp, bank) is the one
 * set in CRM Settings → Quotation, so a quotation and the invoice that follows
 * it come from the same company on paper. Every figure is the saved invoice's.
 *
 * Print / PDF is the browser's own dialog — "Save as PDF" there gives the file.
 * The print stylesheet hides the page around the sheet. */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import '../../styles/invoice-print.css'
import { fetchImage } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { IconClose, IconDownload, IconPrinter } from '../../components/Icons'
import { crm } from '../crm/api'
import { qtyText, rupees, type Invoice } from './api'

const TITLE: Record<string, string> = {
  product: 'Tax Invoice', service: 'Tax Invoice', milestone: 'Tax Invoice',
  proforma: 'Proforma Invoice', credit_note: 'Credit Note',
}
const COPIES = ['Original for recipient', 'Duplicate for transporter', 'Triplicate for supplier'] as const

const longDate = (iso: string | null | undefined) =>
  iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
const num = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function useImage(kind: 'logo' | 'stamp', present: boolean | undefined, version: string | null | undefined) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!present) return setSrc(null)
    let url: string | null = null
    let cancelled = false
    fetchImage(`/api/v1/crm/settings/quotation-images/${kind}?v=${encodeURIComponent(version ?? '')}`)
      .then((made) => { if (cancelled) return URL.revokeObjectURL(made); url = made; setSrc(made) })
      .catch(() => !cancelled && setSrc(null))
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url) }
  }, [kind, present, version])
  return src
}

/** "Rupees Twelve Thousand Three Hundred Only" — lakh and crore. */
export function amountInWords(amount: number): string {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
    'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
  const two = (n: number) => (n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ''}`)
  const three = (n: number) => [n >= 100 ? `${ones[Math.floor(n / 100)]} Hundred` : '', n % 100 ? two(n % 100) : ''].filter(Boolean).join(' ')
  const words = (n: number): string => {
    if (n === 0) return 'Zero'
    const parts: string[] = []
    if (Math.floor(n / 1e7)) parts.push(`${words(Math.floor(n / 1e7))} Crore`)
    if (Math.floor((n % 1e7) / 1e5)) parts.push(`${two(Math.floor((n % 1e7) / 1e5))} Lakh`)
    if (Math.floor((n % 1e5) / 1e3)) parts.push(`${two(Math.floor((n % 1e5) / 1e3))} Thousand`)
    if (n % 1e3) parts.push(three(n % 1e3))
    return parts.join(' ')
  }
  const safe = Math.max(0, Math.round((Number.isFinite(amount) ? amount : 0) * 100))
  const paise = safe % 100
  return `Rupees ${words(Math.floor(safe / 100))}${paise ? ` and ${two(paise)} Paise` : ''} Only`
}

/** The file name an invoice downloads as: its number, or the draft's party. */
export const pdfFileName = (inv: Invoice) =>
  `${(inv.number ?? `draft-${inv.customer_name}`).replace(/[\\/:*?"<>|\s]+/g, '-')}.pdf`

/** Download an invoice's PDF without opening the print view — the list's
 *  Download button. Same letterhead and layout as the print view's. */
export async function downloadInvoicePdf(inv: Invoice, copy: string = COPIES[0]): Promise<void> {
  const [{ buildInvoicePdf, imageData }, defaults] = await Promise.all([import('./invoicePdf'), crm.quotationDefaults()])
  const s = defaults.setup ?? null
  const image = async (kind: 'logo' | 'stamp', present?: boolean) => {
    if (!present) return null
    const url = await fetchImage(`/api/v1/crm/settings/quotation-images/${kind}?v=${encodeURIComponent(s?.images_version ?? '')}`).catch(() => null)
    const data = await imageData(url)
    if (url) URL.revokeObjectURL(url)
    return data
  }
  const [logo, stamp] = await Promise.all([image('logo', s?.has_logo), image('stamp', s?.has_stamp)])
  buildInvoicePdf({ inv, setup: s, copy, words: amountInWords, logo, stamp }).save(pdfFileName(inv))
}

export default function InvoicePrint({ inv, onClose }: { inv: Invoice; onClose: () => void }) {
  const defaults = useQuery('crm-quotation-defaults', () => crm.quotationDefaults())
  const s = defaults.data?.setup ?? null
  const logo = useImage('logo', s?.has_logo, s?.images_version)
  const stamp = useImage('stamp', s?.has_stamp, s?.images_version)
  const [making, setMaking] = useState(false)
  const [pdfError, setPdfError] = useState<string | null>(null)
  const fileName = pdfFileName(inv)

  /** Print: the browser's dialog. The page title becomes the suggested file
   *  name when "Save as PDF" is picked there. */
  function print() {
    const before = document.title
    document.title = fileName.replace(/\.pdf$/, '')
    window.print()
    document.title = before
  }

  /** Download: a PDF drawn from the invoice's data. The PDF code loads only
   *  now, so the rest of the app does not carry it. */
  async function downloadPdf() {
    setMaking(true)
    setPdfError(null)
    try {
      const { buildInvoicePdf, imageData } = await import('./invoicePdf')
      const [logoData, stampData] = await Promise.all([imageData(logo), imageData(stamp)])
      buildInvoicePdf({ inv, setup: s, copy, words: amountInWords, logo: logoData, stamp: stampData }).save(fileName)
    } catch {
      setPdfError('The PDF could not be made. Use Print → Save as PDF instead.')
    } finally {
      setMaking(false)
    }
  }
  const [copy, setCopy] = useState<(typeof COPIES)[number]>(COPIES[0])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    document.body.classList.add('ip-open')
    return () => { document.removeEventListener('keydown', onKey); document.body.classList.remove('ip-open') }
  }, [onClose])

  const inter = inv.is_interstate
  const tax = Number(inv.tax_total)
  // GST needs tax shown by HSN / SAC and rate.
  const hsn = new Map<string, { hsn: string; rate: number; taxable: number; tax: number; cess: number }>()
  for (const l of inv.lines) {
    const rate = Number(l.gst_percent ?? 0)
    const key = `${l.hsn_sac || '—'}|${rate}`
    const row = hsn.get(key) ?? { hsn: l.hsn_sac || '—', rate, taxable: 0, tax: 0, cess: 0 }
    row.taxable += Number(l.taxable_value ?? 0)
    row.tax += Number(l.tax_amount ?? 0)
    row.cess += Number(l.cess_amount ?? 0)
    hsn.set(key, row)
  }
  const cess = Number(inv.cess_total ?? 0)
  const discounted = inv.lines.some((l) => Number(l.discount_percent ?? 0) || Number(l.discount_amount ?? 0)
    || Number(l.discount2_percent ?? 0) || Number(l.discount2_amount ?? 0))
  const bank = inv.recipient_bank ?? (s?.bank_enabled && s.account_number
    ? { bank_name: s.bank_name ?? '', account_name: s.account_name, account_number: s.account_number, ifsc: s.ifsc, branch: s.branch, upi_id: s.upi_enabled ? s.upi_id : null }
    : null)
  const company = s?.company_name || 'Your company'
  const discText = (l: Invoice['lines'][number]) => [
    Number(l.discount_percent ?? 0) ? `${Number(l.discount_percent)}%` : '',
    Number(l.discount_amount ?? 0) ? `₹${num(l.discount_amount)}` : '',
    Number(l.discount2_percent ?? 0) ? `${Number(l.discount2_percent)}%` : '',
    Number(l.discount2_amount ?? 0) ? `₹${num(l.discount2_amount)}` : '',
  ].filter(Boolean).join(' + ') || '—'

  /* Rendered straight into <body>, outside the app's layout: printing hides
     everything else outright, so the page is exactly one A4 sheet wide and
     the browser has no reason to shrink it. */
  return createPortal(
    <div className="ip-backdrop" role="dialog" aria-modal="true" aria-label="Print invoice">
      <div className="ip-bar">
        <b>{TITLE[inv.kind] ?? 'Invoice'} {inv.number ?? '(draft)'}</b>
        <select value={copy} onChange={(e) => setCopy(e.target.value as typeof copy)} aria-label="Copy">
          {COPIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <span className="ip-gap" />
        {pdfError && <span className="error">{pdfError}</span>}
        <button className="btn" onClick={print}><IconPrinter size={15} /> Print</button>
        <button className="btn btn-primary" disabled={making} onClick={() => void downloadPdf()}>
          <IconDownload size={15} /> {making ? 'Preparing PDF…' : 'Download PDF'}
        </button>
        <button className="btn" onClick={onClose}><IconClose size={15} /> Close</button>
      </div>
      <div className="ip-scroll">
        <article className="ip-sheet" style={s?.accent_color ? { ['--ip-accent' as string]: s.accent_color } : undefined}>
          {inv.status === 'draft' && <div className="ip-watermark">DRAFT</div>}
          {inv.status === 'cancelled' && <div className="ip-watermark">CANCELLED</div>}

          <header className="ip-head">
            <div className="ip-org">
              {logo && <img className="ip-logo" src={logo} alt="" />}
              <div>
                <div className="ip-org-name">{company}</div>
                {s?.tagline && <div className="ip-org-line ip-tagline">{s.tagline}</div>}
                {s?.address && <div className="ip-org-line ip-pre">{s.address}</div>}
                <div className="ip-org-line">
                  {[s?.phone && `Ph: ${s.phone}`, s?.email, s?.website].filter(Boolean).join(' · ')}
                </div>
                <div className="ip-org-line">
                  {[s?.gstin && `GSTIN: ${s.gstin}`, s?.pan && `PAN: ${s.pan}`, s?.cin && `CIN: ${s.cin}`].filter(Boolean).join(' · ')}
                </div>
              </div>
            </div>
            <div className="ip-title">
              <h1>{TITLE[inv.kind] ?? 'Invoice'}</h1>
              <span className="ip-copy">{copy}</span>
            </div>
          </header>

          <section className="ip-meta">
            <dl>
              <div><dt>Invoice no.</dt><dd className="ip-strong">{inv.number ?? 'Draft — not numbered'}</dd></div>
              <div><dt>Invoice date</dt><dd>{longDate(inv.invoice_date)}</dd></div>
              <div><dt>Due date</dt><dd>{longDate(inv.due_date)}</dd></div>
              <div><dt>Place of supply</dt><dd>{inv.place_of_supply || '—'}</dd></div>
            </dl>
            <dl>
              {inv.order_number && <div><dt>Sales order</dt><dd>{inv.order_number}</dd></div>}
              {inv.original_number && <div><dt>Against invoice</dt><dd>{inv.original_number}</dd></div>}
              {inv.delivery_date && <div><dt>Delivery date</dt><dd>{longDate(inv.delivery_date)}</dd></div>}
              {inv.salesperson_name && <div><dt>Salesperson</dt><dd>{inv.salesperson_name}</dd></div>}
              {inv.customer_po_number && <div><dt>Customer PO</dt><dd>{inv.customer_po_number}</dd></div>}
              {inv.payment_reference && <div><dt>Payment ref.</dt><dd>{inv.payment_reference}</dd></div>}
              <div><dt>Reverse charge</dt><dd>{inv.reverse_charge ? 'Yes' : 'No'}</dd></div>
            </dl>
          </section>

          {(inv.dispatch_doc_number || inv.transporter_name || inv.vehicle_number || inv.eway_bill_number || inv.lr_number) && (
            <section className="ip-transport">
              {inv.dispatch_doc_number && <div><span>Dispatch doc. no.</span><b>{inv.dispatch_doc_number}</b></div>}
              {inv.transporter_name && <div><span>Transporter</span><b>{inv.transporter_name}</b></div>}
              {inv.vehicle_number && <div><span>Vehicle no.</span><b>{inv.vehicle_number}</b></div>}
              {inv.eway_bill_number && <div><span>E-way bill no.</span><b>{inv.eway_bill_number}</b></div>}
              {inv.lr_number && <div><span>LR no.</span><b>{inv.lr_number}</b></div>}
            </section>
          )}
          <section className="ip-parties">
            <div>
              <h4>Bill to</h4>
              <b>{inv.customer_name}</b>
              {inv.billing_address && <p className="ip-pre">{inv.billing_address}</p>}
              <p>GSTIN: {inv.gstin || 'Unregistered'}</p>
              {inv.place_of_supply && <p>State: {inv.place_of_supply}</p>}
            </div>
            <div>
              <h4>Ship to</h4>
              <b>{inv.customer_name}</b>
              <p className="ip-pre">{inv.shipping_address || inv.billing_address || '—'}</p>
            </div>
          </section>

          <table className="ip-lines ip-paged">
            <colgroup>
              <col style={{ width: '5%' }} /><col /><col style={{ width: '10%' }} /><col style={{ width: '8%' }} />
              <col style={{ width: '9%' }} />{discounted && <col style={{ width: '7%' }} />}<col style={{ width: '10%' }} />
              <col style={{ width: '6%' }} />{inter ? <col style={{ width: '9%' }} /> : <><col style={{ width: '8%' }} /><col style={{ width: '8%' }} /></>}
              <col style={{ width: '11%' }} />
            </colgroup>
            <thead>
              <tr>
                <th>#</th><th className="ip-desc">Item &amp; description</th><th>HSN/SAC</th>
                <th className="ip-num">Qty</th><th className="ip-num">Rate</th>
                {discounted && <th className="ip-num">Disc.</th>}
                <th className="ip-num">Taxable</th><th className="ip-num">GST</th>
                {inter ? <th className="ip-num">IGST</th> : <><th className="ip-num">CGST</th><th className="ip-num">SGST</th></>}
                <th className="ip-num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {inv.lines.map((l, i) => {
                const t = Number(l.tax_amount ?? 0)
                const half = Math.round((t / 2) * 100) / 100
                return (
                  <tr key={l.id}>
                    <td>{i + 1}</td>
                    <td className="ip-desc">{l.description}{l.item_code && <small> ({l.item_code})</small>}</td>
                    <td>{l.hsn_sac || '—'}</td>
                    <td className="ip-num">{qtyText(l.quantity)} {l.uom}{Number(l.free_qty ?? 0) > 0 && <small><br />+{qtyText(l.free_qty!)} free</small>}</td>
                    <td className="ip-num">{num(l.rate)}</td>
                    {discounted && <td className="ip-num">{discText(l)}</td>}
                    <td className="ip-num">{num(l.taxable_value)}</td>
                    <td className="ip-num">{Number(l.gst_percent ?? 0)}%</td>
                    {inter ? <td className="ip-num">{num(t)}</td> : <><td className="ip-num">{num(half)}</td><td className="ip-num">{num(t - half)}</td></>}
                    <td className="ip-num ip-strong">{num(l.amount)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          <section className="ip-sums">
            <div className="ip-left">
              <table className="ip-hsn">
                <thead>
                  <tr><th>HSN/SAC</th><th className="ip-num">Taxable</th><th className="ip-num">Rate</th>
                    {inter ? <th className="ip-num">IGST</th> : <><th className="ip-num">CGST</th><th className="ip-num">SGST</th></>}
                    {cess > 0 && <th className="ip-num">Cess</th>}
                    <th className="ip-num">Total tax</th></tr>
                </thead>
                <tbody>
                  {[...hsn.values()].map((h) => {
                    const half = Math.round((h.tax / 2) * 100) / 100
                    return (
                      <tr key={`${h.hsn}-${h.rate}`}>
                        <td>{h.hsn}</td><td className="ip-num">{num(h.taxable)}</td><td className="ip-num">{h.rate}%</td>
                        {inter ? <td className="ip-num">{num(h.tax)}</td> : <><td className="ip-num">{num(half)}</td><td className="ip-num">{num(h.tax - half)}</td></>}
                        {cess > 0 && <td className="ip-num">{num(h.cess)}</td>}
                        <td className="ip-num">{num(h.tax + h.cess)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="ip-words"><b>Amount in words:</b> {amountInWords(Number(inv.grand_total))}</p>
              {tax + cess > 0 && <p className="ip-words"><b>Tax in words:</b> {amountInWords(tax + cess)}</p>}
            </div>
            <dl className="ip-totals">
              {(Number(inv.bill_discount_percent ?? 0) > 0 || Number(inv.bill_discount_amount ?? 0) > 0) && (
                <div><dt>Bill discount{Number(inv.bill_discount_percent ?? 0) > 0 ? ` ${Number(inv.bill_discount_percent)}%` : ''}</dt>
                  <dd>{Number(inv.bill_discount_amount ?? 0) > 0 ? `− ${num(inv.bill_discount_amount)}` : 'applied'}</dd></div>
              )}
              {Number(inv.additional_discount ?? 0) > 0 && (
                <div><dt>Addl. discount{inv.discount_reason ? ` (${inv.discount_reason})` : ''}</dt><dd>− {num(inv.additional_discount)}</dd></div>
              )}
              <div><dt>Taxable amount</dt><dd>{num(inv.sub_total)}</dd></div>
              {inter
                ? <div><dt>IGST</dt><dd>{num(inv.igst)}</dd></div>
                : <><div><dt>CGST</dt><dd>{num(inv.cgst)}</dd></div><div><dt>SGST</dt><dd>{num(inv.sgst)}</dd></div></>}
              {cess > 0 && <div><dt>Cess</dt><dd>{num(cess)}</dd></div>}
              <div><dt>Total GST</dt><dd>{num(tax + cess)}</dd></div>
              {Number(inv.round_off ?? 0) !== 0 && <div><dt>Round off</dt><dd>{Number(inv.round_off) > 0 ? '+' : '−'} {num(Math.abs(Number(inv.round_off)))}</dd></div>}
              <div className="ip-grand"><dt>Total</dt><dd>{rupees(inv.grand_total)}</dd></div>
              {Number(inv.amount_received) > 0 && <div><dt>Received</dt><dd>{num(inv.amount_received)}</dd></div>}
              {inv.status === 'posted' && Number(inv.amount_received) > 0 && <div className="ip-due"><dt>Balance due</dt><dd>{rupees(inv.outstanding)}</dd></div>}
            </dl>
          </section>

          <section className="ip-foot">
            <div className="ip-foot-left">
              {bank && (
                <div className="ip-bank">
                  <h4>Bank details</h4>
                  <p>{bank.bank_name}{bank.branch ? `, ${bank.branch}` : ''}</p>
                  {bank.account_name && <p>A/c name: {bank.account_name}</p>}
                  <p>A/c no.: <b>{bank.account_number}</b>{bank.ifsc ? <> · IFSC: <b>{bank.ifsc}</b></> : null}</p>
                  {bank.upi_id && <p>UPI: {bank.upi_id}</p>}
                </div>
              )}
              {inv.notes && <div><h4>Notes</h4><p className="ip-pre">{inv.notes}</p></div>}
              {(inv.terms || s?.footer) && <div><h4>Terms &amp; conditions</h4><p className="ip-pre">{inv.terms || s?.footer}</p></div>}
            </div>
            <div className="ip-sign">
              <div>For <b>{company}</b></div>
              <div className="ip-stamp">{stamp && <img src={stamp} alt="" />}</div>
              <div className="ip-sign-line">{s?.signatory || 'Authorised signatory'}</div>
            </div>
          </section>
          <footer className="ip-note">This is a computer-generated invoice.</footer>
        </article>
      </div>
    </div>,
    document.body,
  )
}
