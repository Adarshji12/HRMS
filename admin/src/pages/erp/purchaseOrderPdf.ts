/* A purchase order as a PDF: the same letterhead and page furniture as the
 * invoice and the sales order. Loaded only when somebody asks for one.
 *
 * jsPDF's built-in fonts have no rupee sign, so money reads "Rs." here. */

import { jsPDF } from 'jspdf'
import { autoTable } from 'jspdf-autotable'
import type { QuotationSetup } from '../crm/api'
import type { PurchaseOrder } from './api'
import { hexRgb, imageType } from './invoicePdf'

const M = 12 // page margin, mm
const W = 210
const H = 297
const INK: [number, number, number] = [17, 26, 34]
const MUTED: [number, number, number] = [91, 104, 114]
const LINE: [number, number, number] = [201, 210, 218]
const SOFT: [number, number, number] = [242, 245, 248]

const num = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const qty = (v: string | number | null | undefined) => {
  const n = Number(v ?? 0)
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)))
}
const shortDate = (iso: string | null | undefined) =>
  iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '-'

export function buildPurchaseOrderPdf(opts: {
  po: PurchaseOrder
  setup: QuotationSetup | null
  /** Label and value pairs, the same ones the print view shows. */
  facts: Array<[string, string]>
  /** DRAFT, NOT APPROVED or CANCELLED, on every page. */
  mark: string | null
  /** The late-delivery clause, when the order has one. */
  clause: string | null
  words: (n: number) => string
  logo: string | null
  stamp: string | null
}): jsPDF {
  const { po, setup: s, facts, mark, clause, words, logo, stamp } = opts
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
  const accent = hexRgb(s?.accent_color)
  const company = s?.company_name || 'Your company'
  const discounted = po.lines.some((l) => Number(l.discount_percent ?? 0))
  const dated = po.lines.some((l) => l.expected_date)
  const freight = Number(po.freight ?? 0)
  const other = Number(po.other_charges ?? 0)
  const last = () => (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY
  doc.setProperties({ title: `Purchase Order ${po.number}`, subject: po.vendor_name ?? '', creator: company })

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
  doc.setFont('helvetica', 'bold').setFontSize(16).setTextColor(...accent).text('PURCHASE ORDER', W - M, M + 6, { align: 'right' })
  y = Math.max(y, M + 12, logo ? M + 20 : 0) + 1
  doc.setDrawColor(...accent).setLineWidth(0.8).line(M, y, W - M, y)
  y += 1

  /* ---- facts ---------------------------------------------------------- */
  const half = Math.ceil(facts.length / 2)
  autoTable(doc, {
    startY: y, margin: { left: M, right: M }, theme: 'plain',
    styles: { fontSize: 8.5, cellPadding: { top: 0.9, bottom: 0.9, left: 2, right: 2 }, textColor: INK },
    columnStyles: { 0: { textColor: MUTED, cellWidth: 30 }, 1: { fontStyle: 'bold', cellWidth: 63 }, 2: { textColor: MUTED, cellWidth: 30 }, 3: { fontStyle: 'bold' } },
    body: Array.from({ length: half }, (_, i) => [facts[i]?.[0] ?? '', facts[i]?.[1] ?? '', facts[half + i]?.[0] ?? '', facts[half + i]?.[1] ?? '']),
    tableLineColor: LINE, tableLineWidth: 0.2,
  })

  /* ---- parties -------------------------------------------------------- */
  const vendor = [po.vendor_name ?? '', po.vendor_address ?? '', `GSTIN: ${po.vendor_gstin || 'Unregistered'}`,
    po.vendor_state ? `State: ${po.vendor_state}` : '',
    [po.vendor_contact, po.vendor_phone, po.vendor_email].filter(Boolean).join(' · ')].filter(Boolean).join('\n')
  const billTo = [company, po.billing_address || s?.address || '', s?.gstin ? `GSTIN: ${s.gstin}` : ''].filter(Boolean).join('\n')
  const shipTo = [po.warehouse_name ?? company, po.warehouse_address ?? '', po.warehouse_name ? '' : po.billing_address || s?.address || ''].filter(Boolean).join('\n')
  const third = (W - 2 * M) / 3
  autoTable(doc, {
    startY: last(), margin: { left: M, right: M }, theme: 'grid',
    styles: { fontSize: 8.5, cellPadding: 2.2, lineColor: LINE, lineWidth: 0.2, textColor: INK, valign: 'top' },
    headStyles: { fillColor: [255, 255, 255], textColor: accent, fontSize: 7.5, fontStyle: 'bold', cellPadding: { top: 2, bottom: 0.5, left: 2.2, right: 2.2 } },
    head: [['VENDOR', 'BILL TO', 'SHIP TO']], body: [[vendor, billTo, shipTo]],
    columnStyles: { 0: { cellWidth: third }, 1: { cellWidth: third }, 2: { cellWidth: third } },
  })

  /* ---- lines ---------------------------------------------------------- */
  const head = ['#', 'Item & description', 'HSN/SAC', 'Qty', 'Rate', ...(discounted ? ['Disc.'] : []), 'Taxable', 'GST', ...(dated ? ['Delivery'] : []), 'Amount']
  const numeric = new Set(head.map((h, i) => (['Qty', 'Rate', 'Disc.', 'Taxable', 'GST', 'Amount'].includes(h) ? i : -1)).filter((i) => i >= 0))
  autoTable(doc, {
    startY: last() + 3, margin: { left: M, right: M, top: M + 6, bottom: 16 }, theme: 'grid', showHead: 'everyPage',
    rowPageBreak: 'avoid',
    styles: { fontSize: 8, cellPadding: 1.6, lineColor: LINE, lineWidth: 0.2, textColor: INK, valign: 'top' },
    headStyles: { fillColor: accent, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7.2, halign: 'left' },
    alternateRowStyles: { fillColor: SOFT },
    columnStyles: { 0: { cellWidth: 7 }, 1: { cellWidth: 'auto', minCellWidth: 42 }, 2: { cellWidth: 17 } },
    head: [head],
    body: po.lines.map((l, i) => [
      String(i + 1), `${l.description}${l.item_code ? `\n${l.item_code}` : ''}`, l.hsn_sac || '-',
      `${qty(l.quantity)} ${l.uom ?? ''}`.trim(), num(l.rate), ...(discounted ? [`${Number(l.discount_percent ?? 0)}%`] : []),
      num(l.taxable_value), `${Number(l.gst_percent ?? 0)}%`, ...(dated ? [shortDate(l.expected_date)] : []), num(l.amount),
    ]),
    didParseCell: (d) => {
      if (numeric.has(d.column.index)) d.cell.styles.halign = 'right'
      if (d.section === 'body' && d.column.index === head.length - 1) d.cell.styles.fontStyle = 'bold'
    },
  })

  /* ---- totals --------------------------------------------------------- */
  const totals: Array<[string, string]> = [
    ['Taxable amount', num(po.sub_total)],
    ...(po.is_interstate ? [['IGST', num(po.igst)]] as Array<[string, string]> : [['CGST', num(po.cgst)], ['SGST', num(po.sgst)]] as Array<[string, string]>),
    ...(freight ? [['Freight charges', num(freight)]] as Array<[string, string]> : []),
    ...(other ? [['Other charges', num(other)]] as Array<[string, string]> : []),
  ]
  const totalsW = 70
  let startY = last() + 4
  if (startY + totals.length * 5.6 + 12 > H - 16) { doc.addPage(); startY = M + 6 }
  autoTable(doc, {
    startY, margin: { left: W - M - totalsW, right: M }, theme: 'grid', pageBreak: 'avoid',
    styles: { fontSize: 8.4, cellPadding: 1.5, lineColor: LINE, lineWidth: 0.2, textColor: INK },
    columnStyles: { 0: { textColor: MUTED }, 1: { halign: 'right' } },
    body: [...totals, ['TOTAL', `Rs. ${num(po.grand_total)}`]],
    didParseCell: (d) => {
      if (d.row.index === totals.length) { d.cell.styles.fillColor = accent; d.cell.styles.textColor = [255, 255, 255]; d.cell.styles.fontStyle = 'bold'; d.cell.styles.fontSize = 10 }
    },
  })
  y = last() + 5

  /* ---- words ---------------------------------------------------------- */
  const wordLines = doc.splitTextToSize(`Amount in words: ${words(Number(po.grand_total))}`, W - 2 * M)
  if (y + wordLines.length * 4 > H - 16) { doc.addPage(); y = M + 6 }
  doc.setFont('helvetica', 'bold').setFontSize(8.5).setTextColor(...INK).text(wordLines, M, y)
  y += wordLines.length * 4 + 2

  /* ---- notes, terms + signature --------------------------------------- */
  const blocks: Array<[string, string]> = []
  if (po.notes) blocks.push(['NOTES', po.notes])
  if (clause) blocks.push(['LATE DELIVERY', clause])
  if (po.terms) blocks.push(['TERMS & CONDITIONS', po.terms])
  const signW = 64
  const textW = W - 2 * M - signW - 6
  const blockHeight = blocks.reduce((h, [, t]) => h + 8 + doc.splitTextToSize(t, textW).length * 3.7, 0)
  if (y + Math.max(blockHeight, 36) > H - 16) { doc.addPage(); y = M + 6 }
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
  const sx = W - M - signW
  doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(...INK).text(`For ${company}`, sx + signW / 2, top + 3, { align: 'center' })
  if (stamp) {
    try { doc.addImage(stamp, imageType(stamp), sx + signW / 2 - 15, top + 6, 30, 20, undefined, 'FAST') } catch { /* skip */ }
  }
  doc.setDrawColor(...INK).line(sx, top + 30, sx + signW, top + 30)
  doc.setFont('helvetica', 'bold').setFontSize(8.5).text(s?.signatory || 'Authorised signatory', sx + signW / 2, top + 34, { align: 'center' })

  /* ---- every page: watermark, footer ---------------------------------- */
  const pages = doc.getNumberOfPages()
  for (let p = 1; p <= pages; p += 1) {
    doc.setPage(p)
    if (mark) {
      const g = doc as unknown as { GState: new (o: { opacity: number }) => unknown; setGState: (g: unknown) => void }
      g.setGState(new g.GState({ opacity: 0.08 }))
      doc.setFont('helvetica', 'bold').setFontSize(mark.length > 9 ? 62 : 90).setTextColor(200, 30, 30).text(mark, W / 2, H / 2, { align: 'center', angle: 28 })
      g.setGState(new g.GState({ opacity: 1 }))
    }
    doc.setDrawColor(...LINE).setLineWidth(0.2).line(M, H - 11, W - M, H - 11)
    doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...MUTED)
    doc.text(`Purchase Order ${po.number}  ·  ${po.vendor_name ?? ''}`, M, H - 7)
    doc.text(`Page ${p} of ${pages}`, W - M, H - 7, { align: 'right' })
  }
  return doc
}
