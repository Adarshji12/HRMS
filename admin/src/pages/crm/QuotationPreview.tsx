/* The quotation as the customer receives it.
 *
 * Rendered from a saved quotation only, so every figure on it is the server's
 * (rule 1 in QuotationEditor). The style comes from the quotation itself, not
 * from today's setting: a proposal raised last month still prints as one.
 *
 * Print / PDF is the browser's own print dialog — "Save as PDF" there gives the
 * file. The print stylesheet hides everything on the page except the sheet.
 */

import { useEffect, useState } from 'react'
import '../../styles/quotation-preview.css'
import { fetchImage } from '../../lib/api'
import { IconClose, IconDownload } from '../../components/Icons'
import { rupees, type Quotation, type QuotationSetup } from './api'

function useImage(kind: 'logo' | 'stamp', present: boolean | undefined, version: string | null | undefined) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!present) return setSrc(null)
    let url: string | null = null
    let cancelled = false
    fetchImage(`/api/v1/crm/settings/quotation-images/${kind}?v=${encodeURIComponent(version ?? '')}`)
      .then((made) => {
        if (cancelled) return URL.revokeObjectURL(made)
        url = made
        setSrc(made)
      })
      .catch(() => !cancelled && setSrc(null))
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [kind, present, version])
  return src
}

const longDate = (iso: string | null | undefined) =>
  iso
    ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
      })
    : '—'

const plain = (value: string | null | undefined) => {
  const n = Number(value ?? 0)
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

export default function QuotationPreview({
  quotation, setup, onClose,
}: {
  quotation: Quotation
  setup: QuotationSetup | null
  onClose: () => void
}) {
  const s = setup
  const detailed = quotation.style === 'detailed'
  const logo = useImage('logo', s?.has_logo, s?.images_version)
  const stamp = useImage('stamp', s?.has_stamp, s?.images_version)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    document.body.classList.add('qp-open')
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.classList.remove('qp-open')
    }
  }, [onClose])

  /* {customer}, {company}, {number} and {date} in the letter templates. */
  const fill = (text: string | null | undefined) =>
    (text ?? '')
      .replace(/\{customer\}/g, quotation.customer_name ?? 'Sir / Madam')
      .replace(/\{company\}/g, s?.company_name ?? '')
      .replace(/\{number\}/g, quotation.number)
      .replace(/\{date\}/g, longDate(quotation.quote_date))

  const hasDiscount = quotation.lines.some((line) => Number(line.discount) > 0)
  const shipTo = quotation.shipping_address
  const place = [quotation.city, quotation.state, quotation.pincode].filter(Boolean).join(', ')
  const terms: Array<[string, string | null]> = detailed
    ? [
        ['Payment terms', quotation.payment_terms],
        ['Delivery terms', quotation.delivery_terms],
        ['Warranty', quotation.warranty_terms],
        ['Terms & conditions', quotation.terms],
      ]
    : [['Terms & conditions', quotation.terms]]

  return (
    <div className="qp-backdrop" role="dialog" aria-modal="true" aria-label={`Preview of ${quotation.number}`}>
      <div className="qp-bar">
        <span className="qp-bar-title">
          {quotation.number}
          <span className="qp-bar-sub">{detailed ? 'Detailed / Proposal' : 'Simple'} quotation</span>
        </span>
        <button className="btn btn-primary btn-sm" onClick={() => window.print()}>
          <IconDownload size={14} /> Print / Save PDF
        </button>
        <button className="crm-icon-btn qp-close" onClick={onClose} aria-label="Close preview">
          <IconClose size={16} />
        </button>
      </div>

      <div className="qp-scroll" onClick={(event) => event.target === event.currentTarget && onClose()}>
        <article
          className={`qp-sheet${detailed ? ' is-detailed' : ''}${s?.letterhead_align === 'center' ? ' is-center' : ''}`}
          style={{ ['--qp-accent' as string]: detailed ? s?.accent_color ?? '#0b3a66' : '#1f2937' }}
        >
          <header className="qp-head">
            {logo && <img className="qp-logo" src={logo} alt="" />}
            <div className="qp-org">
              <div className="qp-org-name">{s?.company_name || 'Your company'}</div>
              {detailed && s?.tagline && <div className="qp-org-tag">{s.tagline}</div>}
              {s?.address && <div className="qp-org-line">{s.address}</div>}
              <div className="qp-org-line">
                {[s?.phone, s?.email, s?.website].filter(Boolean).join('  ·  ')}
              </div>
              {s?.gstin && (!detailed || s.show_gstin_in_header) && (
                <div className="qp-org-line">
                  GSTIN {s.gstin}
                  {detailed && s.pan ? `  ·  PAN ${s.pan}` : ''}
                  {detailed && s.cin ? `  ·  CIN ${s.cin}` : ''}
                </div>
              )}
            </div>
            <div className="qp-title">
              <div className="qp-title-word">Quotation</div>
              <dl className="qp-meta">
                <dt>No.</dt><dd>{quotation.number}</dd>
                <dt>Date</dt><dd>{longDate(quotation.quote_date)}</dd>
                <dt>Valid till</dt><dd>{longDate(quotation.valid_until)}</dd>
              </dl>
            </div>
          </header>

          <section className={`qp-parties${shipTo ? '' : ' is-single'}`}>
            <div>
              <div className="qp-label">Bill to</div>
              <div className="qp-party-name">{quotation.customer_name || '—'}</div>
              {quotation.company && <div>{quotation.company}</div>}
              {quotation.billing_address && <div className="qp-pre">{quotation.billing_address}</div>}
              {place && <div>{place}</div>}
              <div>{[quotation.mobile, quotation.email].filter(Boolean).join('  ·  ')}</div>
              {quotation.gstin && <div>GSTIN {quotation.gstin}</div>}
            </div>
            {shipTo && (
              <div>
                <div className="qp-label">Ship to</div>
                <div className="qp-pre">{shipTo}</div>
              </div>
            )}
          </section>

          {detailed && (quotation.subject || quotation.letter_body) && (
            <section className="qp-letter">
              {quotation.subject && (
                <p className="qp-subject"><b>Subject:</b> {fill(quotation.subject)}</p>
              )}
              <p>{fill(s?.letter_greeting) || `Dear ${quotation.customer_name ?? 'Sir / Madam'},`}</p>
              {quotation.letter_body && <p className="qp-pre">{fill(quotation.letter_body)}</p>}
            </section>
          )}

          <table className="qp-items">
            <thead>
              <tr>
                <th className="qp-c">#</th>
                <th>Item &amp; description</th>
                <th>HSN/SAC</th>
                <th className="qp-r">Qty</th>
                <th className="qp-r">Rate</th>
                {hasDiscount && <th className="qp-r">Discount</th>}
                <th className="qp-r">GST</th>
                <th className="qp-r">Amount</th>
              </tr>
            </thead>
            <tbody>
              {quotation.lines.map((line, index) => (
                <tr key={line.id ?? index}>
                  <td className="qp-c">{index + 1}</td>
                  <td>
                    <div className="qp-item">{line.name}</div>
                    {line.description && <div className="qp-desc">{line.description}</div>}
                  </td>
                  <td>{line.hsn_sac || '—'}</td>
                  <td className="qp-r">{plain(line.quantity)}</td>
                  <td className="qp-r">{rupees(line.rate)}</td>
                  {hasDiscount && (
                    <td className="qp-r">
                      {Number(line.discount) > 0
                        ? line.discount_is_percent ? `${plain(line.discount)}%` : rupees(line.discount)
                        : '—'}
                    </td>
                  )}
                  <td className="qp-r">{plain(line.gst_percent)}%</td>
                  <td className="qp-r">{rupees(line.amount ?? '0')}</td>
                </tr>
              ))}
              {quotation.lines.length === 0 && (
                <tr><td colSpan={hasDiscount ? 8 : 7} className="qp-c qp-muted">No items yet</td></tr>
              )}
            </tbody>
          </table>

          <section className="qp-sum">
            <div className="qp-pay">
              {s?.bank_enabled && s.account_number && (
                <div className="qp-block">
                  <div className="qp-label">Bank details</div>
                  <div>{s.account_name}</div>
                  <div>{s.bank_name}{s.branch ? `, ${s.branch}` : ''}</div>
                  <div>A/c {s.account_number}{s.ifsc ? `  ·  IFSC ${s.ifsc}` : ''}</div>
                </div>
              )}
              {s?.upi_enabled && s.upi_id && (
                <div className="qp-block">
                  <div className="qp-label">UPI</div>
                  <div>{s.upi_id}{s.upi_name ? ` (${s.upi_name})` : ''}</div>
                </div>
              )}
            </div>
            <dl className="qp-totals">
              <dt>Sub total</dt><dd>{rupees(quotation.sub_total)}</dd>
              {Number(quotation.discount_total) > 0 && (
                <><dt>Discount</dt><dd>− {rupees(quotation.discount_total)}</dd></>
              )}
              <dt>Taxable value</dt><dd>{rupees(quotation.taxable_value)}</dd>
              {quotation.is_interstate ? (
                <><dt>IGST</dt><dd>{rupees(quotation.igst)}</dd></>
              ) : (
                <>
                  <dt>CGST</dt><dd>{rupees(quotation.cgst)}</dd>
                  <dt>SGST</dt><dd>{rupees(quotation.sgst)}</dd>
                </>
              )}
              <dt className="qp-grand">Grand total</dt><dd className="qp-grand">{rupees(quotation.grand_total)}</dd>
            </dl>
          </section>

          {terms.some(([, text]) => text) && (
            <section className="qp-terms">
              {terms.filter(([, text]) => text).map(([label, text]) => (
                <div key={label} className="qp-block">
                  <div className="qp-label">{label}</div>
                  <div className="qp-pre">{text}</div>
                </div>
              ))}
            </section>
          )}

          <footer className="qp-foot">
            <div className="qp-foot-note">
              {detailed && s?.letter_closing && <p className="qp-pre">{fill(s.letter_closing)}</p>}
              {s?.footer && <p className="qp-pre qp-muted">{fill(s.footer)}</p>}
            </div>
            <div className="qp-sign">
              <div>For {s?.company_name || 'the company'}</div>
              <div className="qp-sign-space">{stamp && <img src={stamp} alt="" />}</div>
              <div className="qp-sign-name">{s?.signatory || 'Authorised signatory'}</div>
            </div>
          </footer>
        </article>
      </div>
    </div>
  )
}
