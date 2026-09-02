/* The quotation builder — priced from the masters, editable line by line.
 *
 * Two rules the whole screen is built around:
 *
 * 1. **The server owns the arithmetic.** Every total shown after a save is what
 *    the server computed, never a number this file added up. The preview while
 *    typing is explicitly a preview and is replaced by the saved figures the
 *    moment there are any — because the document a customer receives is the
 *    server's, and two implementations of GST rounding is one too many.
 * 2. **Picking a product fills the line in; it does not own it.** Rate and GST
 *    come from the master as a starting point and can be typed over, and the
 *    line keeps whatever it was saved with even if the master changes later.
 *    That is what makes a sent quotation still say what it said.
 *
 * A quotation raised against a lead or a customer copies their details onto the
 * document rather than reading through to them at print time. Editing the party
 * block here changes this quotation only, and the page says so.
 */

import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import '../../styles/crm.css'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { ErrorNote, Loading } from '../../components/ui'
import { IconPlus, IconReturn, IconSheet } from '../../components/Icons'
import {
  crm,
  crmError,
  daysFromTodayISO,
  rupees,
  todayISO,
  type Product,
  type PlanRow,
  type Quotation,
  type QuotationLine,
} from './api'
import { CrmPage, Field, StateText } from './parts'

interface DraftLine extends QuotationLine {
  key: string
}

const emptyLine = (): DraftLine => ({
  key: Math.random().toString(36).slice(2),
  product_id: null,
  plan_id: null,
  name: '',
  description: null,
  hsn_sac: null,
  quantity: '1',
  rate: '0',
  discount: '0',
  discount_is_percent: true,
  gst_percent: '0',
})

export default function QuotationEditor() {
  const { quotationId } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const isNew = !quotationId || quotationId === 'new'

  const existing = useQuery<Quotation | null>(
    `crm-quotation-${quotationId ?? 'new'}`,
    () => (isNew ? Promise.resolve(null) : crm.quotation(quotationId!)),
    { enabled: !isNew },
  )

  const products = useQuery<Product[]>('crm-products-all', () => crm.masters<Product>('products'))
  const plans = useQuery<PlanRow[]>('crm-plans-all', () => crm.masters<PlanRow>('plans'))
  const settings = useQuery('crm-settings-quote', () => crm.settings().catch(() => null))
  /* The company's own state decides CGST+SGST against IGST. Read here only to
     tell the person which way the document will be taxed *before* they save —
     the decision itself is the server's. */
  const company = useQuery('crm-company', () =>
    api.get<{ state: string | null }>('/org/company'),
  )

  const [quoteDate, setQuoteDate] = useState(todayISO())
  const [validUntil, setValidUntil] = useState(daysFromTodayISO(15))
  const [customerName, setCustomerName] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [gstin, setGstin] = useState('')
  const [mobile, setMobile] = useState('')
  const [whatsapp, setWhatsapp] = useState('')
  const [email, setEmail] = useState('')
  const [city, setCity] = useState('')
  const [state, setState] = useState('')
  const [pincode, setPincode] = useState('')
  const [billing, setBilling] = useState('')
  const [sameShipping, setSameShipping] = useState(true)
  const [shipping, setShipping] = useState('')
  const [terms, setTerms] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()])
  const [leadId, setLeadId] = useState<string | null>(null)
  const [customerId, setCustomerId] = useState<string | null>(params.get('customer'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<Quotation | null>(null)

  /* Load an existing document into the form. */
  useEffect(() => {
    const row = existing.data
    if (!row) return
    setSaved(row)
    setQuoteDate(row.quote_date)
    setValidUntil(row.valid_until ?? '')
    setCustomerName(row.customer_name ?? '')
    setCompanyName(row.company ?? '')
    setGstin(row.gstin ?? '')
    setMobile(row.mobile ?? '')
    setWhatsapp(row.whatsapp ?? '')
    setEmail(row.email ?? '')
    setCity(row.city ?? '')
    setState(row.state ?? '')
    setPincode(row.pincode ?? '')
    setBilling(row.billing_address ?? '')
    setSameShipping(!row.shipping_address)
    setShipping(row.shipping_address ?? '')
    setTerms(row.terms ?? '')
    setNotes(row.notes ?? '')
    setLeadId(row.lead_id)
    setCustomerId(row.customer_id)
    setLines(
      row.lines.length
        ? row.lines.map((line) => ({ ...line, key: line.id ?? Math.random().toString(36).slice(2) }))
        : [emptyLine()],
    )
  }, [existing.data])

  /* A quotation opened from a customer starts with their details on it. */
  useEffect(() => {
    if (!isNew || !customerId || saved) return
    void crm
      .customer(customerId)
      .then((customer) => {
        setCustomerName(customer.name)
        setCompanyName(customer.company ?? '')
        setGstin(customer.gstin ?? '')
        setMobile(customer.mobile)
        setWhatsapp(customer.whatsapp ?? '')
        setEmail(customer.email ?? '')
        setCity(customer.city_name ?? '')
        setState(customer.state_name ?? '')
        setPincode(customer.pincode ?? '')
        setBilling(customer.address ?? '')
      })
      .catch(() => {
        /* A customer that cannot be read is not an error on a blank quotation —
           the party block is typeable by hand, which is the point of it. */
      })
  }, [customerId, isNew, saved])

  useEffect(() => {
    if (isNew && settings.data?.quotation_terms && !terms) setTerms(settings.data.quotation_terms)
  }, [settings.data, isNew, terms])

  const homeState = (company.data?.state ?? '').trim().toLowerCase()
  const placeOfSupply = state.trim().toLowerCase()
  const interstate = Boolean(homeState && placeOfSupply && homeState !== placeOfSupply)

  /* A preview only. The saved figures below replace it as soon as there are
     any — see rule 1 at the top of this file. */
  const preview = useMemo(() => {
    let sub = 0
    let discount = 0
    let taxable = 0
    let tax = 0
    for (const line of lines) {
      const gross = Number(line.quantity || 0) * Number(line.rate || 0)
      const off = line.discount_is_percent
        ? (gross * Number(line.discount || 0)) / 100
        : Number(line.discount || 0)
      const clamped = Math.min(off, gross)
      const net = gross - clamped
      sub += gross
      discount += clamped
      taxable += net
      tax += (net * Number(line.gst_percent || 0)) / 100
    }
    return { sub, discount, taxable, tax, total: taxable + tax }
  }, [lines])

  function patchLine(key: string, patch: Partial<DraftLine>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)))
  }

  /* Picking a product fills the line in from the master. Anything already typed
     into the name is kept: somebody who wrote "Installation — Pune site" and
     then chose a product to get its GST rate did not ask for their text back. */
  function applyProduct(key: string, productId: string) {
    const product = (products.data ?? []).find((row) => row.id === productId)
    patchLine(key, {
      product_id: productId || null,
      plan_id: null,
      name:
        lines.find((line) => line.key === key)?.name?.trim() ||
        product?.name ||
        '',
      hsn_sac: product?.hsn_sac ?? null,
      rate: product ? product.rate : '0',
      gst_percent: product ? product.gst_percent : '0',
    })
  }

  function applyPlan(key: string, planId: string) {
    const plan = (plans.data ?? []).find((row) => row.id === planId)
    const line = lines.find((row) => row.key === key)
    patchLine(key, {
      plan_id: planId || null,
      rate: plan ? plan.price : line?.rate ?? '0',
      gst_percent: plan?.gst_percent ?? line?.gst_percent ?? '0',
      name: line?.name || `${plan?.product_name ?? ''} ${plan?.name ?? ''}`.trim(),
    })
  }

  async function save(nextStatus?: string) {
    setBusy(true)
    setError(null)
    const body = {
      quote_date: quoteDate,
      valid_until: validUntil || null,
      lead_id: leadId,
      customer_id: customerId,
      customer_name: customerName || null,
      company: companyName || null,
      gstin: gstin || null,
      mobile: mobile || null,
      whatsapp: whatsapp || null,
      email: email || null,
      city: city || null,
      state: state || null,
      pincode: pincode || null,
      billing_address: billing || null,
      shipping_address: sameShipping ? null : shipping || null,
      terms: terms || null,
      notes: notes || null,
      lines: lines
        .filter((line) => line.name.trim())
        .map((line) => ({
          product_id: line.product_id,
          plan_id: line.plan_id,
          name: line.name,
          description: line.description,
          hsn_sac: line.hsn_sac,
          quantity: line.quantity || '1',
          rate: line.rate || '0',
          discount: line.discount || '0',
          discount_is_percent: line.discount_is_percent,
          gst_percent: line.gst_percent || '0',
        })),
    }
    try {
      const row = saved
        ? await crm.updateQuotation(saved.id, body)
        : await crm.createQuotation(body)
      let final = row
      if (nextStatus) final = await crm.setQuotationStatus(row.id, { status: nextStatus })
      setSaved(final)
      setLines(
        final.lines.length
          ? final.lines.map((line) => ({ ...line, key: line.id ?? Math.random().toString(36).slice(2) }))
          : [emptyLine()],
      )
      if (!saved) navigate(`/crm/quotations/${final.id}`, { replace: true })
    } catch (err) {
      setError(crmError(err, 'That quotation could not be saved'))
    } finally {
      setBusy(false)
    }
  }

  if (!isNew && existing.loading) {
    return (
      <CrmPage title="Quotation">
        <Loading label="Opening the quotation…" />
      </CrmPage>
    )
  }
  if (!isNew && existing.error) {
    return (
      <CrmPage title="Quotation">
        <ErrorNote>{crmError(existing.cause, 'That quotation could not be opened')}</ErrorNote>
      </CrmPage>
    )
  }

  const decided = saved?.status === 'accepted' || saved?.status === 'rejected'

  return (
    <CrmPage
      title={saved ? saved.number : 'New Quotation'}
      subtitle="Priced from your masters, editable line by line"
      actions={
        <button className="btn" onClick={() => navigate('/crm/quotations')}>
          <IconReturn size={15} /> All quotations
        </button>
      }
    >
      {error && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {decided && (
        <div className="notice notice-warn" style={{ marginBottom: 12 }}>
          This quotation has been answered, so it can no longer be edited. Copy it if you need to
          send a revision — the original stays exactly as the customer saw it.
        </div>
      )}

      <section className="card" style={{ marginBottom: 14 }}>
        <div className="crm-doc-head">
          <div>
            <div className="crm-doc-number">
              <IconSheet size={16} />
              {saved ? saved.number : 'Draft'}
              {saved && <StateText value={saved.status} />}
            </div>
            <div className="crm-field-hint">
              {saved
                ? 'The number is fixed once saved, so it is never used twice.'
                : 'A number is reserved when you save.'}
            </div>
          </div>
          <div className="crm-doc-dates">
            <Field label="Date">
              <input
                type="date"
                value={quoteDate}
                onChange={(event) => setQuoteDate(event.target.value)}
                disabled={decided}
              />
            </Field>
            <Field label="Valid until">
              <input
                type="date"
                value={validUntil}
                onChange={(event) => setValidUntil(event.target.value)}
                disabled={decided}
              />
            </Field>
            <button className="btn btn-primary" onClick={() => save()} disabled={busy || decided}>
              {busy ? 'Saving…' : saved ? 'Save changes' : 'Save as Draft'}
            </button>
            {saved && (
              <select
                value=""
                onChange={(event) => event.target.value && save(event.target.value)}
                aria-label="Mark as"
                disabled={busy}
              >
                <option value="">Mark as…</option>
                <option value="sent">Sent</option>
                <option value="accepted">Accepted</option>
                <option value="rejected">Rejected</option>
                <option value="expired">Expired</option>
                <option value="failed">Failed to send</option>
              </select>
            )}
          </div>
        </div>
      </section>

      <section className="card" style={{ marginBottom: 14 }}>
        <div className="crm-panel-head">
          <h2 className="crm-panel-title">Customer details</h2>
        </div>
        <p className="crm-field-hint" style={{ padding: '0 16px' }}>
          {leadId || customerId
            ? 'Copied from the record. Editing here changes this quotation only — the lead or customer stays as it is.'
            : 'Typed by hand. Raise a quotation from a lead or a customer to have these filled in.'}
        </p>
        <div className="crm-grid-4" style={{ padding: 16 }}>
          <Field label="Customer name">
            <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} disabled={decided} />
          </Field>
          <Field label="Company">
            <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} disabled={decided} />
          </Field>
          <Field label="GSTIN">
            <input value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} disabled={decided} />
          </Field>
          <Field label="Mobile">
            <input value={mobile} onChange={(e) => setMobile(e.target.value)} disabled={decided} />
          </Field>
          <Field label="WhatsApp">
            <input value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} disabled={decided} />
          </Field>
          <Field label="Email">
            <input value={email} onChange={(e) => setEmail(e.target.value)} disabled={decided} />
          </Field>
          <Field label="City">
            <input value={city} onChange={(e) => setCity(e.target.value)} disabled={decided} />
          </Field>
          <Field
            label="State"
            hint={
              interstate ? (
                <span className="crm-field-warn">
                  Differs from your company state — IGST applies.
                </span>
              ) : homeState ? (
                'Same state as your company — CGST and SGST apply.'
              ) : (
                'Set your company state in Settings → Company profile so the tax split is decided for you.'
              )
            }
          >
            <input value={state} onChange={(e) => setState(e.target.value)} disabled={decided} />
          </Field>
          <Field label="Pincode">
            <input value={pincode} onChange={(e) => setPincode(e.target.value)} disabled={decided} />
          </Field>
          <Field label="Billing address" wide>
            <textarea value={billing} onChange={(e) => setBilling(e.target.value)} rows={3} disabled={decided} />
          </Field>
          <div className="crm-field crm-form-wide">
            <label className="crm-check">
              <input
                type="checkbox"
                checked={sameShipping}
                onChange={(event) => setSameShipping(event.target.checked)}
                disabled={decided}
              />
              <span>
                Shipping address is the same
                <span className="crm-field-hint"> Turn off to print a separate Ship To block.</span>
              </span>
            </label>
            {!sameShipping && (
              <textarea
                value={shipping}
                onChange={(event) => setShipping(event.target.value)}
                rows={3}
                disabled={decided}
              />
            )}
          </div>
        </div>
      </section>

      <section className="card" style={{ marginBottom: 14 }}>
        <div className="crm-panel-head">
          <h2 className="crm-panel-title">Products &amp; services</h2>
          <span className="crm-field-hint">
            Rate and GST come from the master; changing them here does not move it.
          </span>
          <button
            className="btn btn-sm crm-panel-link"
            onClick={() => setLines((current) => [...current, emptyLine()])}
            disabled={decided}
          >
            <IconPlus size={14} /> Add line
          </button>
        </div>

        <div className="table-wrap">
          <table className="crm-lines">
            <thead>
              <tr>
                <th style={{ width: 28 }}>#</th>
                <th>Product / Service</th>
                <th>Plan</th>
                <th>Qty</th>
                <th>Rate (₹)</th>
                <th>Discount</th>
                <th>GST %</th>
                <th className="crm-num">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => {
                const gross = Number(line.quantity || 0) * Number(line.rate || 0)
                const off = line.discount_is_percent
                  ? (gross * Number(line.discount || 0)) / 100
                  : Number(line.discount || 0)
                const net = Math.max(0, gross - off)
                const amount = net + (net * Number(line.gst_percent || 0)) / 100
                return (
                  <tr key={line.key}>
                    <td className="crm-sub">{index + 1}</td>
                    <td>
                      <div className="crm-line-name-cell">
                        <select
                          value={line.product_id ?? ''}
                          onChange={(event) => applyProduct(line.key, event.target.value)}
                          disabled={decided}
                        >
                          <option value="">— Custom line —</option>
                          {(products.data ?? [])
                            .filter((product) => product.is_active)
                            .map((product) => (
                              <option key={product.id} value={product.id}>
                                {product.name}
                              </option>
                            ))}
                        </select>
                        <input
                          value={line.name}
                          onChange={(event) => patchLine(line.key, { name: event.target.value })}
                          placeholder="Item name as it should print"
                          disabled={decided}
                        />
                        <input
                          value={line.description ?? ''}
                          onChange={(event) =>
                            patchLine(line.key, { description: event.target.value || null })
                          }
                          placeholder="+ Description"
                          disabled={decided}
                        />
                      </div>
                    </td>
                    <td>
                      <select
                        value={line.plan_id ?? ''}
                        onChange={(event) => applyPlan(line.key, event.target.value)}
                        disabled={decided || !line.product_id}
                      >
                        <option value="">{line.product_id ? '—' : 'Pick a product first'}</option>
                        {(plans.data ?? [])
                          .filter((plan) => plan.product_id === line.product_id)
                          .map((plan) => (
                            <option key={plan.id} value={plan.id}>
                              {plan.name}
                            </option>
                          ))}
                      </select>
                    </td>
                    <td>
                      <input
                        className="crm-line-qty"
                        value={line.quantity}
                        onChange={(event) => patchLine(line.key, { quantity: event.target.value })}
                        inputMode="decimal"
                        disabled={decided}
                      />
                    </td>
                    <td>
                      <input
                        className="crm-line-rate"
                        value={line.rate}
                        onChange={(event) => patchLine(line.key, { rate: event.target.value })}
                        inputMode="decimal"
                        disabled={decided}
                      />
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input
                          className="crm-line-disc"
                          value={line.discount}
                          onChange={(event) => patchLine(line.key, { discount: event.target.value })}
                          inputMode="decimal"
                          disabled={decided}
                        />
                        <select
                          value={line.discount_is_percent ? '%' : '₹'}
                          onChange={(event) =>
                            patchLine(line.key, { discount_is_percent: event.target.value === '%' })
                          }
                          disabled={decided}
                          aria-label="Discount type"
                        >
                          <option>%</option>
                          <option>₹</option>
                        </select>
                      </div>
                    </td>
                    <td>
                      <input
                        className="crm-line-gst"
                        value={line.gst_percent}
                        onChange={(event) => patchLine(line.key, { gst_percent: event.target.value })}
                        inputMode="decimal"
                        disabled={decided}
                      />
                    </td>
                    <td className="crm-num">{rupees(line.amount ?? amount)}</td>
                    <td>
                      <button
                        className="crm-icon-btn"
                        onClick={() =>
                          setLines((current) =>
                            current.length === 1
                              ? [emptyLine()]
                              : current.filter((row) => row.key !== line.key),
                          )
                        }
                        disabled={decided}
                        aria-label={`Remove line ${index + 1}`}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="crm-totals">
          {saved ? (
            <>
              <div className="crm-total-row">
                <span>Sub Total</span>
                <span>{rupees(saved.sub_total)}</span>
              </div>
              {Number(saved.discount_total) > 0 && (
                <div className="crm-total-row">
                  <span>Discount</span>
                  <span>− {rupees(saved.discount_total)}</span>
                </div>
              )}
              <div className="crm-total-row">
                <span>Taxable Value</span>
                <span>{rupees(saved.taxable_value)}</span>
              </div>
              {saved.is_interstate ? (
                <div className="crm-total-row">
                  <span>IGST</span>
                  <span>{rupees(saved.igst)}</span>
                </div>
              ) : (
                <>
                  <div className="crm-total-row">
                    <span>CGST</span>
                    <span>{rupees(saved.cgst)}</span>
                  </div>
                  <div className="crm-total-row">
                    <span>SGST</span>
                    <span>{rupees(saved.sgst)}</span>
                  </div>
                </>
              )}
              <div className="crm-total-grand">
                <span>Grand Total</span>
                <span>{rupees(saved.grand_total)}</span>
              </div>
            </>
          ) : (
            <>
              <div className="crm-total-row">
                <span>Sub Total</span>
                <span>{rupees(preview.sub)}</span>
              </div>
              <div className="crm-total-row">
                <span>Taxable Value</span>
                <span>{rupees(preview.taxable)}</span>
              </div>
              <div className="crm-total-row">
                <span>{interstate ? 'IGST' : 'CGST + SGST'}</span>
                <span>{rupees(preview.tax)}</span>
              </div>
              <div className="crm-total-grand">
                <span>Grand Total</span>
                <span>{rupees(preview.total)}</span>
              </div>
              <p className="crm-field-hint">
                A preview. The figures on the document are the ones the server computes when you
                save.
              </p>
            </>
          )}
        </div>
      </section>

      <section className="card">
        <div className="crm-grid-2" style={{ padding: 16 }}>
          <Field label="Terms &amp; conditions" hint="Defaults from CRM Settings.">
            <textarea value={terms} onChange={(e) => setTerms(e.target.value)} rows={4} disabled={decided} />
          </Field>
          <Field label="Internal notes" hint="Not printed on the quotation.">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} disabled={decided} />
          </Field>
        </div>
      </section>
    </CrmPage>
  )
}
