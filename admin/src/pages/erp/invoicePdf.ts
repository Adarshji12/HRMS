/* The invoice as a downloadable PDF — drawn from the invoice's data, not a
 * screenshot, so its text is sharp, selectable and small.
 *
 * Same content and order as the printed sheet (InvoicePrint): letterhead,
 * invoice facts, bill-to / ship-to, transport, the lines, the HSN tax summary
 * beside the totals, amounts in words, bank, notes, terms and the signature.
 * The lines table repeats its header on every page and never splits a row;
 * every page carries "Page x of y" and the invoice number.
 *
 * jsPDF's built-in fonts have no rupee sign, so money reads "Rs." here.
 * Loaded only when somebody downloads (see InvoicePrint). */

import { jsPDF } from 'jspdf'
import { autoTable } from 'jspdf-autotable'
import type { QuotationSetup } from '../crm/api'
import type { Invoice } from './api'

const TITLE: Record<string, string> = {
  product: 'TAX INVOICE', service: 'TAX INVOICE', milestone: 'TAX INVOICE',
  proforma: 'PROFORMA INVOICE', credit_note: 'CREDIT NOTE',
}
const M = 12 // page margin, mm
const W = 210
const H = 297
const INK: [number, number, number] = [17, 26, 34]
const MUTED: [number, number, number] = [91, 104, 114]
const LINE: [number, number, number] = [201, 210, 218]
const SOFT: [number, number, number] = [242, 245, 248]

const num = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const rs = (v: string | number | null | undefined) => `Rs. ${num(v)}`
const qty = (v: string | number | null | undefined) => {
  const n = Number(v ?? 0)
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)))
}
const longDate = (iso: string | null | undefined) =>
  iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-'

function hexRgb(hex: string | null | undefined): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim())
  if (!m) return [11, 58, 99]
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** A blob: or http URL of an image as a data URL jsPDF can embed. */
export async function imageData(src: string | null): Promise<string | null> {
  if (!src) return null
  try {
    const blob = await (await fetch(src)).blob()
    return await new Promise((resolve) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = () => resolve(null)
      r.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

function imageType(data: string): string {
  return data.startsWith('data:image/png') ? 'PNG' : data.startsWith('data:image/webp') ? 'WEBP' : 'JPEG'
}

export function buildInvoicePdf(opts: {
  inv: Invoice
  setup: QuotationSetup | null
  copy: string
  words: (n: number) => string
  logo: string | null
  stamp: string | null
}): jsPDF {
  const { inv, setup: s, copy, words, logo, stamp } = opts
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
  const accent = hexRgb(s?.accent_color)
  const company = s?.company_name || 'Your company'
  const inter = inv.is_interstate
  const cess = Number(inv.cess_total ?? 0)
  const tax = Number(inv.tax_total ?? 0)
  const discounted = inv.lines.some((l) => Number(l.discount_percent ?? 0) || Number(l.discount_amount ?? 0)
    || Number(l.discount2_percent ?? 0) || Number(l.discount2_amount ?? 0))
  const last = () => (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY
  doc.setProperties({ title: `${TITLE[inv.kind] ?? 'Invoice'} ${inv.number ?? 'draft'}`, subject: inv.customer_name, creator: company })

  /* ---- letterhead ---------------------------------------------------- */
  let x = M
  if (logo) {
    try { doc.addImage(logo, imageType(logo), M, M, 18, 18, undefined, 'FAST'); x = M + 22 } catch { /* unreadable logo: skip it */ }
  }
  doc.setFont('helvetica', 'bold').setFontSize(15).setTextColor(...accent).text(company, x, M + 5)
  doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTED)
  const orgLines = [
    s?.tagline ?? '', ...(s?.address ?? '').split('\n'),
    [s?.phone && `Ph: ${s.phone}`, s?.email, s?.website].filter(Boolean).join('  ·  '),
    [s?.gstin && `GSTIN: ${s.gstin}`, s?.pan && `PAN: ${s.pan}`, s?.cin && `CIN: ${s.cin}`].filter(Boolean).join('  ·  '),
  ].filter((t) => t && t.trim())
  let y = M + 9.5
  for (const t of orgLines.slice(0, 6)) { doc.text(doc.splitTextToSize(t, 110)[0], x, y); y += 3.6 }
  doc.setFont('helvetica', 'bold').setFontSize(16).setTextColor(...accent).text(TITLE[inv.kind] ?? 'INVOICE', W - M, M + 6, { align: 'right' })
  doc.setFontSize(7).setDrawColor(...accent)
  const cw = doc.getTextWidth(copy.toUpperCase()) + 4
  doc.roundedRect(W - M - cw, M + 9, cw, 5, 0.8, 0.8)
  doc.text(copy.toUpperCase(), W - M - cw / 2, M + 12.5, { align: 'center' })
  // Below the copy label, and the logo when there is one.
  y = Math.max(y, M + 16, logo ? M + 20 : 0) + 1
  doc.setDrawColor(...accent).setLineWidth(0.8).line(M, y, W - M, y)
  y += 1

  /* ---- facts ---------------------------------------------------------- */
  const left: Array<[string, string]> = [
    ['Invoice no.', inv.number ?? 'Draft - not numbered'], ['Invoice date', longDate(inv.invoice_date)],
    ['Due date', longDate(inv.due_date)], ['Place of supply', inv.place_of_supply || '-'],
  ]
  const right: Array<[string, string]> = [
    ...(inv.order_number ? [['Sales order', inv.order_number]] as Array<[string, string]> : []),
    ...(inv.customer_po_number ? [['Customer PO', inv.customer_po_number]] as Array<[string, string]> : []),
    ...(inv.delivery_date ? [['Delivery date', longDate(inv.delivery_date)]] as Array<[string, string]> : []),
    ...(inv.salesperson_name ? [['Salesperson', inv.salesperson_name]] as Array<[string, string]> : []),
    ...(inv.payment_reference ? [['Payment ref.', inv.payment_reference]] as Array<[string, string]> : []),
    ['Reverse charge', inv.reverse_charge ? 'Yes' : 'No'],
  ]
  const rows = Math.max(left.length, right.length)
  autoTable(doc, {
    startY: y, margin: { left: M, right: M }, theme: 'plain',
    styles: { fontSize: 8.5, cellPadding: { top: 0.9, bottom: 0.9, left: 2, right: 2 }, textColor: INK },
    columnStyles: { 0: { textColor: MUTED, cellWidth: 30 }, 1: { fontStyle: 'bold', cellWidth: 63 }, 2: { textColor: MUTED, cellWidth: 30 }, 3: {} },
    body: Array.from({ length: rows }, (_, i) => [left[i]?.[0] ?? '', left[i]?.[1] ?? '', right[i]?.[0] ?? '', right[i]?.[1] ?? '']),
    tableLineColor: LINE, tableLineWidth: 0.2,
  })

  /* ---- parties -------------------------------------------------------- */
  const billTo = [inv.customer_name, inv.billing_address ?? '', `GSTIN: ${inv.gstin || 'Unregistered'}`,
    inv.place_of_supply ? `State: ${inv.place_of_supply}` : ''].filter(Boolean).join('\n')
  const shipTo = [inv.customer_name, inv.shipping_address || inv.billing_address || '-'].join('\n')
  autoTable(doc, {
    startY: last(), margin: { left: M, right: M }, theme: 'grid',
    styles: { fontSize: 8.5, cellPadding: 2.2, lineColor: LINE, lineWidth: 0.2, textColor: INK, valign: 'top' },
    headStyles: { fillColor: [255, 255, 255], textColor: accent, fontSize: 7.5, fontStyle: 'bold', cellPadding: { top: 2, bottom: 0.5, left: 2.2, right: 2.2 } },
    head: [['BILL TO', 'SHIP TO']], body: [[billTo, shipTo]],
    columnStyles: { 0: { cellWidth: (W - 2 * M) / 2 }, 1: { cellWidth: (W - 2 * M) / 2 } },
    didParseCell: (d) => { if (d.section === 'body') d.cell.styles.fontStyle = 'normal' },
  })

  /* ---- transport ------------------------------------------------------ */
  const transport = [
    inv.dispatch_doc_number && `Dispatch doc. no.: ${inv.dispatch_doc_number}`,
    inv.transporter_name && `Transporter: ${inv.transporter_name}`,
    inv.vehicle_number && `Vehicle no.: ${inv.vehicle_number}`,
    inv.eway_bill_number && `E-way bill no.: ${inv.eway_bill_number}`,
    inv.lr_number && `LR no.: ${inv.lr_number}`,
  ].filter(Boolean) as string[]
  if (transport.length) {
    autoTable(doc, {
      startY: last(), margin: { left: M, right: M }, theme: 'grid',
      styles: { fontSize: 8, cellPadding: 1.8, fillColor: SOFT, lineColor: LINE, lineWidth: 0.2, textColor: INK },
      body: [[transport.join('     ')]],
    })
  }

  /* ---- lines ---------------------------------------------------------- */
  const head = ['#', 'Item & description', 'HSN/SAC', 'Qty', 'Rate', ...(discounted ? ['Disc.'] : []), 'Taxable', 'GST',
    ...(inter ? ['IGST'] : ['CGST', 'SGST']), ...(cess > 0 ? ['Cess'] : []), 'Amount']
  const disc = (l: Invoice['lines'][number]) => [
    Number(l.discount_percent ?? 0) ? `${Number(l.discount_percent)}%` : '', Number(l.discount_amount ?? 0) ? num(l.discount_amount) : '',
    Number(l.discount2_percent ?? 0) ? `${Number(l.discount2_percent)}%` : '', Number(l.discount2_amount ?? 0) ? num(l.discount2_amount) : '',
  ].filter(Boolean).join(' + ') || '-'
  const body = inv.lines.map((l, i) => {
    const t = Number(l.tax_amount ?? 0)
    const half = Math.round((t / 2) * 100) / 100
    const name = `${l.description}${l.item_code ? `\n${l.item_code}` : ''}${Number(l.free_qty ?? 0) > 0 ? `\n+ ${qty(l.free_qty)} free` : ''}`
    return [String(i + 1), name, l.hsn_sac || '-', `${qty(l.quantity)} ${l.uom ?? ''}`.trim(), num(l.rate),
      ...(discounted ? [disc(l)] : []), num(l.taxable_value), `${Number(l.gst_percent ?? 0)}%`,
      ...(inter ? [num(t)] : [num(half), num(t - half)]), ...(cess > 0 ? [num(l.cess_amount)] : []), num(l.amount)]
  })
  const numeric = new Set(head.map((h, i) => (['Qty', 'Rate', 'Disc.', 'Taxable', 'GST', 'IGST', 'CGST', 'SGST', 'Cess', 'Amount'].includes(h) ? i : -1)).filter((i) => i >= 0))
  autoTable(doc, {
    startY: last() + 3, margin: { left: M, right: M, top: M + 6, bottom: 16 }, theme: 'grid', showHead: 'everyPage',
    rowPageBreak: 'avoid',
    styles: { fontSize: 8, cellPadding: 1.6, lineColor: LINE, lineWidth: 0.2, textColor: INK, valign: 'top' },
    headStyles: { fillColor: accent, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7.2, halign: 'left' },
    alternateRowStyles: { fillColor: SOFT },
    columnStyles: { 0: { cellWidth: 7 }, 1: { cellWidth: 'auto', minCellWidth: 38 }, 2: { cellWidth: 17 } },
    head: [head], body,
    didParseCell: (d) => {
      if (numeric.has(d.column.index)) d.cell.styles.halign = 'right'
      if (d.section === 'body' && d.column.index === head.length - 1) d.cell.styles.fontStyle = 'bold'
    },
  })

  /* ---- HSN summary beside the totals ---------------------------------- */
  const hsn = new Map<string, { hsn: string; rate: number; taxable: number; tax: number; cess: number }>()
  for (const l of inv.lines) {
    const rate = Number(l.gst_percent ?? 0)
    const key = `${l.hsn_sac || '-'}|${rate}`
    const row = hsn.get(key) ?? { hsn: l.hsn_sac || '-', rate, taxable: 0, tax: 0, cess: 0 }
    row.taxable += Number(l.taxable_value ?? 0); row.tax += Number(l.tax_amount ?? 0); row.cess += Number(l.cess_amount ?? 0)
    hsn.set(key, row)
  }
  const totals: Array<[string, string]> = [
    ...(Number(inv.bill_discount_percent ?? 0) || Number(inv.bill_discount_amount ?? 0)
      ? [[`Bill discount${Number(inv.bill_discount_percent ?? 0) ? ` ${Number(inv.bill_discount_percent)}%` : ''}`,
        Number(inv.bill_discount_amount ?? 0) ? `- ${num(inv.bill_discount_amount)}` : 'applied']] as Array<[string, string]> : []),
    ...(Number(inv.additional_discount ?? 0) ? [[`Addl. discount${inv.discount_reason ? ` (${inv.discount_reason})` : ''}`, `- ${num(inv.additional_discount)}`]] as Array<[string, string]> : []),
    ['Taxable amount', num(inv.sub_total)],
    ...(inter ? [['IGST', num(inv.igst)]] as Array<[string, string]> : [['CGST', num(inv.cgst)], ['SGST', num(inv.sgst)]] as Array<[string, string]>),
    ...(cess > 0 ? [['Cess', num(cess)]] as Array<[string, string]> : []),
    ['Total GST', num(tax + cess)],
    ...(Number(inv.round_off ?? 0) ? [['Round off', `${Number(inv.round_off) > 0 ? '+' : '-'} ${num(Math.abs(Number(inv.round_off)))}`]] as Array<[string, string]> : []),
  ]
  const totalsW = 70
  // Keep the summary block together: start it on a new page when it will not fit.
  const need = Math.max(hsn.size * 6 + 10, totals.length * 5.6 + 12) + 22
  let startY = last() + 4
  if (startY + need > H - 16) { doc.addPage(); startY = M + 6 }
  const page = doc.getNumberOfPages()
  autoTable(doc, {
    startY, margin: { left: M, right: M + totalsW + 4 }, theme: 'grid', pageBreak: 'avoid',
    styles: { fontSize: 7.6, cellPadding: 1.4, lineColor: LINE, lineWidth: 0.2, textColor: INK },
    headStyles: { fillColor: [68, 81, 92], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7 },
    head: [['HSN/SAC', 'Taxable', 'Rate', ...(inter ? ['IGST'] : ['CGST', 'SGST']), ...(cess > 0 ? ['Cess'] : []), 'Total tax']],
    body: [...hsn.values()].map((h) => {
      const half = Math.round((h.tax / 2) * 100) / 100
      return [h.hsn, num(h.taxable), `${h.rate}%`, ...(inter ? [num(h.tax)] : [num(half), num(h.tax - half)]), ...(cess > 0 ? [num(h.cess)] : []), num(h.tax + h.cess)]
    }),
    didParseCell: (d) => { if (d.column.index > 0) d.cell.styles.halign = 'right' },
  })
  const hsnEnd = last()
  doc.setPage(page)
  autoTable(doc, {
    startY, margin: { left: W - M - totalsW, right: M }, theme: 'grid', pageBreak: 'avoid',
    styles: { fontSize: 8.4, cellPadding: 1.5, lineColor: LINE, lineWidth: 0.2, textColor: INK },
    columnStyles: { 0: { textColor: MUTED }, 1: { halign: 'right' } },
    body: [...totals, ['TOTAL', rs(inv.grand_total)]],
    didParseCell: (d) => {
      if (d.row.index === totals.length) { d.cell.styles.fillColor = accent; d.cell.styles.textColor = [255, 255, 255]; d.cell.styles.fontStyle = 'bold'; d.cell.styles.fontSize = 10 }
      if (d.row.raw && String((d.row.raw as string[])[0]).startsWith('Total GST')) d.cell.styles.fontStyle = 'bold'
    },
  })
  y = Math.max(hsnEnd, last()) + 5

  /* ---- words ---------------------------------------------------------- */
  doc.setFontSize(8.5).setTextColor(...INK)
  const wordsText = (label: string, n: number) => {
    const lines = doc.splitTextToSize(`${label}: ${words(n)}`, W - 2 * M)
    if (y + lines.length * 4 > H - 16) { doc.addPage(); y = M + 6 }
    doc.setFont('helvetica', 'bold').text(lines, M, y); y += lines.length * 4
  }
  wordsText('Amount in words', Number(inv.grand_total))
  if (tax + cess > 0) { doc.setFont('helvetica', 'normal'); wordsText('Tax in words', tax + cess) }

  /* ---- bank, notes, terms + signature --------------------------------- */
  const bank = inv.recipient_bank ?? (s?.bank_enabled && s.account_number
    ? { bank_name: s.bank_name ?? '', account_name: s.account_name, account_number: s.account_number, ifsc: s.ifsc, branch: s.branch, upi_id: s.upi_enabled ? s.upi_id : null }
    : null)
  const blocks: Array<[string, string]> = []
  if (bank) {
    blocks.push(['BANK DETAILS', [
      `${bank.bank_name}${bank.branch ? `, ${bank.branch}` : ''}`, bank.account_name ? `A/c name: ${bank.account_name}` : '',
      `A/c no.: ${bank.account_number}${bank.ifsc ? `   IFSC: ${bank.ifsc}` : ''}`, bank.upi_id ? `UPI: ${bank.upi_id}` : '',
    ].filter(Boolean).join('\n')])
  }
  if (inv.notes) blocks.push(['NOTES', inv.notes])
  if (inv.terms || s?.footer) blocks.push(['TERMS & CONDITIONS', (inv.terms || s?.footer) ?? ''])
  y += 2
  const signW = 64
  const textW = W - 2 * M - signW - 6
  const blockHeight = blocks.reduce((h, [, t]) => h + 6 + doc.splitTextToSize(t, textW).length * 3.7, 0)
  if (y + Math.max(blockHeight, 34) > H - 16) { doc.addPage(); y = M + 6 }
  doc.setDrawColor(...LINE).setLineWidth(0.2).line(M, y - 1, W - M, y - 1)
  const top = y + 2
  let ly = top
  for (const [title, text] of blocks) {
    doc.setFont('helvetica', 'bold').setFontSize(7.5).setTextColor(...accent).text(title, M, ly + 3)
    doc.setFont('helvetica', 'normal').setFontSize(8.2).setTextColor(...INK)
    const lines = doc.splitTextToSize(text, textW)
    doc.text(lines, M, ly + 7)
    ly += 6 + lines.length * 3.7 + 2
  }
  // Signature
  const sx = W - M - signW
  doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(...INK).text(`For ${company}`, sx + signW / 2, top + 3, { align: 'center' })
  if (stamp) {
    try { doc.addImage(stamp, imageType(stamp), sx + signW / 2 - 15, top + 6, 30, 20, undefined, 'FAST') } catch { /* skip */ }
  }
  doc.setDrawColor(...INK).line(sx, top + 30, sx + signW, top + 30)
  doc.setFont('helvetica', 'bold').setFontSize(8.5).text(s?.signatory || 'Authorised signatory', sx + signW / 2, top + 34, { align: 'center' })

  /* ---- every page: watermark, footer ---------------------------------- */
  const pages = doc.getNumberOfPages()
  const mark = inv.status === 'draft' ? 'DRAFT' : inv.status === 'cancelled' ? 'CANCELLED' : null
  for (let p = 1; p <= pages; p += 1) {
    doc.setPage(p)
    if (mark) {
      const g = doc as unknown as { GState: new (o: { opacity: number }) => unknown; setGState: (g: unknown) => void }
      g.setGState(new g.GState({ opacity: 0.08 }))
      doc.setFont('helvetica', 'bold').setFontSize(90).setTextColor(200, 30, 30).text(mark, W / 2, H / 2, { align: 'center', angle: 28 })
      g.setGState(new g.GState({ opacity: 1 }))
    }
    doc.setDrawColor(...LINE).setLineWidth(0.2).line(M, H - 11, W - M, H - 11)
    doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...MUTED)
    doc.text(`${TITLE[inv.kind] ?? 'Invoice'} ${inv.number ?? '(draft)'}  ·  ${inv.customer_name}`, M, H - 7)
    doc.text('This is a computer-generated invoice.', W / 2, H - 7, { align: 'center' })
    doc.text(`Page ${p} of ${pages}`, W - M, H - 7, { align: 'right' })
  }
  return doc
}
