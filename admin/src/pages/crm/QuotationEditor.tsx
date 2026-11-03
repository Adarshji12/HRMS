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

import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import '../../styles/crm.css'
import { useQuery } from '../../lib/useQuery'
import { ErrorNote, Loading } from '../../components/ui'
import { IconChevronDown, IconEdit, IconPlus, IconReturn, IconSheet } from '../../components/Icons'
import QuotationPreview from './QuotationPreview'
import {
  crm,
  crmError,
  daysFromTodayISO,
  rupees,
  todayISO,
  type Customer,
  type Product,
  type Quotation,
  type QuotationLine,
} from './api'
import { CrmPage, Field, StateText } from './parts'

interface DraftLine extends QuotationLine {
  key: string
}

const emptyLine = (gst = '0'): DraftLine => ({
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
  gst_percent: gst,
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
  /* Terms, validity, the default GST rate and the company's own GST state —
     the last read here only to tell the person which way the document will be
     taxed *before* they save; the decision itself is the server's. Readable by
     every CRM user, unlike the settings it comes from. */
  const defaults = useQuery('crm-quotation-defaults', () => crm.quotationDefaults().catch(() => null))
  const defaultGst = defaults.data?.default_gst ?? '0'

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
  const [leadId, setLeadId] = useState<string | null>(params.get('lead'))
  const [customerId, setCustomerId] = useState<string | null>(params.get('customer'))
  /* The Customer name field lists CRM › My Customers as you type. */
  const myCustomers = useQuery<Customer[]>('crm-customers-all', () => crm.customers({}))
  /* Detailed / Proposal only — see the setup's style. */
  const [subject, setSubject] = useState('')
  const [letterBody, setLetterBody] = useState('')
  const [paymentTerms, setPaymentTerms] = useState('')
  const [deliveryTerms, setDeliveryTerms] = useState('')
  const [warrantyTerms, setWarrantyTerms] = useState('')
  /* Raised from a lead or customer, the party block arrives filled in and
     shows as a summary; Edit opens the fields. */
  const [editingParty, setEditingParty] = useState(!params.get('lead') && !params.get('customer'))
  const [previewing, setPreviewing] = useState(false)
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
    setSubject(row.subject ?? '')
    setLetterBody(row.letter_body ?? '')
    setPaymentTerms(row.payment_terms ?? '')
    setDeliveryTerms(row.delivery_terms ?? '')
    setWarrantyTerms(row.warranty_terms ?? '')
    setLeadId(row.lead_id)
    setCustomerId(row.customer_id)
    setEditingParty(!row.lead_id && !row.customer_id)
    setLines(
      row.lines.length
        ? row.lines.map((line) => ({ ...line, key: line.id ?? Math.random().toString(36).slice(2) }))
        : [emptyLine()],
    )
  }, [existing.data])

  /* Picking a customer from My Customers fills the party block from them;
     clearing the pick leaves what is typed, but no longer tied to anyone. */
  function pickCustomer(id: string) {
    const c = (myCustomers.data ?? []).find((x) => x.id === id) ?? null
    if (!c) {
      setCustomerId(null)
      setEditingParty(true)
      return
    }
    setCustomerId(c.id)
    setCustomerName(c.name)
    setCompanyName(c.company ?? '')
    setGstin(c.gstin ?? '')
    setMobile(c.mobile)
    setWhatsapp(c.whatsapp ?? '')
    setEmail(c.email ?? '')
    setCity(c.city_name ?? '')
    setState(c.state_name ?? '')
    setPincode(c.pincode ?? '')
    setBilling(c.address ?? '')
    setEditingParty(false)
  }

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

  /* A quotation opened from a lead starts with the lead's details, and with
     the product the lead asked about already on the first line. */
  const [leadProduct, setLeadProduct] = useState<string | null>(null)
  useEffect(() => {
    if (!isNew || !leadId || customerId || saved) return
    void crm
      .lead(leadId)
      .then((lead) => {
        setCustomerName(lead.name)
        setCompanyName(lead.company ?? '')
        setMobile(lead.mobile)
        setWhatsapp(lead.whatsapp ?? '')
        setEmail(lead.email ?? '')
        setCity(lead.city_name ?? '')
        setState(lead.state_name ?? '')
        setPincode(lead.pincode ?? '')
        setBilling(lead.address ?? '')
        setLeadProduct(lead.product_id)
      })
      .catch(() => setEditingParty(true))
  }, [leadId, customerId, isNew, saved])

  useEffect(() => {
    if (!leadProduct || !products.data) return
    const first = lines[0]
    if (lines.length === 1 && first && !first.product_id && !first.name) applyProduct(first.key, leadProduct)
    setLeadProduct(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadProduct, products.data])

  const setup = defaults.data?.setup ?? null
  const style = saved?.style ?? setup?.style ?? 'simple'
  const detailed = style === 'detailed'

  useEffect(() => {
    if (isNew && defaults.data?.terms && !terms) setTerms(defaults.data.terms)
  }, [defaults.data, isNew, terms])

  /* A new quotation's validity and its first blank line follow the settings,
     once — after that they are the person's to change. */
  const [seeded, setSeeded] = useState(false)
  useEffect(() => {
    if (!isNew || seeded || !defaults.data) return
    setSeeded(true)
    setValidUntil(daysFromTodayISO(defaults.data.validity_days))
    const templates = defaults.data.setup
    if (templates?.style === 'detailed') {
      setSubject(templates.letter_subject ?? '')
      setLetterBody(templates.letter_body ?? '')
      setPaymentTerms(templates.payment_terms ?? '')
      setDeliveryTerms(templates.delivery_terms ?? '')
      setWarrantyTerms(templates.warranty_terms ?? '')
    }
    const gst = defaults.data.default_gst
    setLines((current) =>
      current.map((line) => (!line.product_id && !line.name && line.gst_percent === '0' ? { ...line, gst_percent: gst } : line)),
    )
  }, [defaults.data, isNew, seeded])

  const homeState = (defaults.data?.home_state ?? '').trim().toLowerCase()
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
      // The default rate stands in only where the product carries none.
      gst_percent: product && product.gst_percent != null && product.gst_percent !== '' ? product.gst_percent : defaultGst,
    })
  }

  async function save(nextStatus?: string, thenPreview = false) {
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
      style,
      subject: subject || null,
      letter_body: letterBody || null,
      payment_terms: paymentTerms || null,
      delivery_terms: deliveryTerms || null,
      warranty_terms: warrantyTerms || null,
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
      if (thenPreview) setPreviewing(true)
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
    <CrmPage>
      <div className="qe">
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

      <section className="card qe-card">
        <div className="crm-doc-head">
          <div>
            <div className="crm-doc-number">
              <IconSheet size={16} />
              {saved ? saved.number : 'New quotation'}
              {saved ? <StateText value={saved.status} /> : <span className="qe-draft">Draft</span>}
            </div>
            <div className="crm-field-hint">
              {detailed ? 'Detailed / Proposal' : 'Simple'} quotation
              {' · '}
              {saved ? 'number fixed once saved' : 'a number is reserved when you save'}
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
            <button className="btn qe-back" onClick={() => navigate('/crm/quotations?all')}>
              <IconReturn size={14} /> All quotations
            </button>
            <SaveMenu
              busy={busy}
              decided={decided}
              label={busy ? 'Saving…' : saved ? 'Save changes' : 'Save as Draft'}
              onSave={() => save()}
              // Marks it Sent and opens the document to print or share as PDF.
              onSend={() => save(saved?.status === 'sent' ? undefined : 'sent', true)}
              // The preview is the server's document, so it saves first —
              // an answered quotation is shown as it stands.
              onPreview={() => (decided && saved ? setPreviewing(true) : save(undefined, true))}
            />
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

      <section className="card qe-card">
        <div className="crm-panel-head">
          <h2 className="crm-panel-title">Customer details</h2>
          <span className="crm-field-hint">
            {leadId || customerId
              ? `Fetched from the ${leadId ? 'lead' : 'customer'} — edits change this quotation only.`
              : 'Type a name to pick from My Customers, or fill the details by hand.'}
          </span>
          {state && (
            <span className={`qe-tax${interstate ? ' is-inter' : ''}`}>
              {interstate ? 'IGST · inter-state' : homeState ? 'CGST + SGST · same state' : 'Set your company state for the tax split'}
            </span>
          )}
          {!editingParty && !decided && (
            <button className="btn btn-sm crm-panel-link" onClick={() => setEditingParty(true)}>
              <IconEdit size={14} /> Edit details
            </button>
          )}
        </div>
        {!editingParty ? (
          <div className="qe-party">
            <div className="qe-party-who">
              <b>{customerName || '—'}</b>
              {companyName && <span>{companyName}</span>}
            </div>
            <dl className="qe-party-facts">
              <div><dt>Mobile</dt><dd>{mobile || '—'}</dd></div>
              <div><dt>Email</dt><dd>{email || '—'}</dd></div>
              <div><dt>GSTIN</dt><dd>{gstin || '—'}</dd></div>
              <div>
                <dt>Place of supply</dt>
                <dd>
                  {[city, state, pincode].filter(Boolean).join(', ') || '—'}
                  {interstate && <span className="crm-field-warn"> · IGST</span>}
                </dd>
              </div>
              <div className="qe-party-wide"><dt>Billing address</dt><dd>{billing || '—'}</dd></div>
            </dl>
          </div>
        ) : (
        <div className="crm-grid-4 qe-body">
          <Field label="Customer name">
            {leadId || decided ? (
              <input placeholder="e.g. Rahul Sharma" value={customerName} onChange={(e) => setCustomerName(e.target.value)} disabled={decided} />
            ) : (
              <NameCombo
                value={customerName}
                customers={myCustomers.data ?? []}
                onType={(text) => {
                  setCustomerName(text)
                  // A typed name is no longer the picked customer.
                  if (customerId) setCustomerId(null)
                }}
                onPick={pickCustomer}
              />
            )}
          </Field>
          <Field label="Company">
            <input placeholder="e.g. Acme Industries Pvt Ltd" value={companyName} onChange={(e) => setCompanyName(e.target.value)} disabled={decided} />
          </Field>
          <Field label="GSTIN">
            <input placeholder="22AAAAA0000A1Z5" value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} disabled={decided} />
          </Field>
          <Field label="Mobile">
            <input placeholder="9876543210" value={mobile} onChange={(e) => setMobile(e.target.value)} disabled={decided} />
          </Field>
          <Field label="WhatsApp">
            <input placeholder="9876543210" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} disabled={decided} />
          </Field>
          <Field label="Email">
            <input placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} disabled={decided} />
          </Field>
          <Field label="City">
            <input placeholder="e.g. Pune" value={city} onChange={(e) => setCity(e.target.value)} disabled={decided} />
          </Field>
          <Field label="State">
            <input placeholder="e.g. Maharashtra" value={state} onChange={(e) => setState(e.target.value)} disabled={decided} />
          </Field>
          <Field label="Pincode">
            <input placeholder="6-digit pincode" value={pincode} onChange={(e) => setPincode(e.target.value)} disabled={decided} />
          </Field>
          <Field label="Billing address" wide>
            <textarea value={billing} onChange={(e) => setBilling(e.target.value)} rows={1} disabled={decided}
              placeholder="Building, street, area" />
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
              <textarea placeholder="e.g. Plot 14, MIDC Industrial Area, Pune 411019"
                value={shipping}
                onChange={(event) => setShipping(event.target.value)}
                rows={2}
                disabled={decided}
              />
            )}
          </div>
        </div>
        )}
      </section>

      <section className="card qe-card">
        <div className="crm-panel-head">
          <h2 className="crm-panel-title">Products &amp; services</h2>
          <span className="crm-field-hint">
            Rate and GST come from the master; changing them here does not move it.
          </span>
          <button
            className="btn btn-sm crm-panel-link"
            onClick={() => setLines((current) => [...current, emptyLine(defaultGst)])}
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
                <th>HSN / SAC</th>
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
                      <input
                        className="crm-line-hsn"
                        value={line.hsn_sac ?? ''}
                        onChange={(event) => patchLine(line.key, { hsn_sac: event.target.value || null })}
                        placeholder="From product"
                        maxLength={16}
                        disabled={decided}
                      />
                    </td>
                    <td>
                      <input placeholder="1"
                        className="crm-line-qty"
                        value={line.quantity}
                        onChange={(event) => patchLine(line.key, { quantity: event.target.value })}
                        inputMode="decimal"
                        disabled={decided}
                      />
                    </td>
                    <td>
                      <input placeholder="0"
                        className="crm-line-rate"
                        value={line.rate}
                        onChange={(event) => patchLine(line.key, { rate: event.target.value })}
                        inputMode="decimal"
                        disabled={decided}
                      />
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input placeholder="0"
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
                      <input placeholder="18"
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
                              ? [emptyLine(defaultGst)]
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
      </section>

      {detailed && (
        <section className="card qe-card">
          <div className="crm-panel-head">
            <h2 className="crm-panel-title">Proposal letter</h2>
            <span className="crm-field-hint">
              Printed above the items. {'{customer}'}, {'{company}'}, {'{number}'} and {'{date}'} are filled in.
            </span>
          </div>
          <div className="qe-body qe-letter">
            <Field label="Subject">
              <input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={decided}
                     maxLength={200} placeholder="Quotation for …" />
            </Field>
            <Field label="Covering letter">
              <textarea placeholder="e.g. Thank you for your enquiry. Please find our quotation below." value={letterBody} onChange={(e) => setLetterBody(e.target.value)} rows={4}
                        disabled={decided} />
            </Field>
          </div>
        </section>
      )}

      <section className="card qe-card qe-foot">
        <div className={`qe-notes${detailed ? ' is-detailed' : ''}`}>
          {detailed && (
            <>
              <Field label="Payment terms">
                <textarea placeholder="e.g. 50% advance, balance on delivery" value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} rows={3}
                          disabled={decided} />
              </Field>
              <Field label="Delivery terms">
                <textarea placeholder="e.g. Within 7 working days of order" value={deliveryTerms} onChange={(e) => setDeliveryTerms(e.target.value)} rows={3}
                          disabled={decided} />
              </Field>
              <Field label="Warranty">
                <textarea placeholder="e.g. 1 year against manufacturing defects" value={warrantyTerms} onChange={(e) => setWarrantyTerms(e.target.value)} rows={3}
                          disabled={decided} />
              </Field>
            </>
          )}
          <Field label="Terms &amp; conditions" hint="Defaults from CRM Settings.">
            <textarea placeholder="e.g. Prices exclusive of GST" value={terms} onChange={(e) => setTerms(e.target.value)} rows={3} disabled={decided} />
          </Field>
          <Field label="Internal notes" hint="Not printed on the quotation.">
            <textarea placeholder="e.g. Valid for 15 days" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} disabled={decided} />
          </Field>
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
      </div>
      {previewing && saved && (
        <QuotationPreview quotation={saved} setup={setup} onClose={() => setPreviewing(false)} />
      )}
    </CrmPage>
  )
}


/** The Customer name field: type freely, or pick one of My Customers from the
 *  list that opens under it — picking fills the rest of the party block. */
function NameCombo({ value, customers, onType, onPick }: {
  value: string
  customers: Customer[]
  onType: (text: string) => void
  onPick: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState(0)
  const q = value.trim().toLowerCase()
  const shown = customers
    .filter((c) => !q || [c.name, c.company, c.mobile, c.code, c.city_name].some((v) => v?.toLowerCase().includes(q)))
    .slice(0, 8)
  const pick = (c: Customer) => { onPick(c.id); setOpen(false) }
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  // A click anywhere outside closes the list, whatever has focus.
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])
  return (
    <div className={`qe-combo${open ? ' is-open' : ''}`} ref={box}>
      <input
        ref={input}
        value={value}
        placeholder="Type or pick a customer"
        // Not "off": Chrome ignores that and lays its saved-address popup over the list.
        autoComplete="one-time-code"
        name="qe-customer-search"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        onChange={(e) => { onType(e.target.value); setOpen(true); setAt(0) }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || e.key === 'Tab') { if (open && e.key === 'Escape') e.preventDefault(); setOpen(false); return }
          if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); return }
          if (!open || !shown.length) return
          if (e.key === 'ArrowDown') { e.preventDefault(); setAt((n) => Math.min(n + 1, shown.length - 1)) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setAt((n) => Math.max(n - 1, 0)) }
          if (e.key === 'Enter') { e.preventDefault(); pick(shown[at]) }
        }}
      />
      <button type="button" className="qe-combo-caret" tabIndex={-1} aria-label={open ? 'Close the list' : 'Open the list'}
        onMouseDown={(e) => {
          // Keep focus in the box; the arrow only opens and closes the list.
          e.preventDefault()
          if (open) { setOpen(false); return }
          input.current?.focus()
          setOpen(true)
        }} />
      {open && (
        <ul className="qe-combo-list" role="listbox">
          {shown.length === 0 ? (
            <li className="qe-combo-empty">{customers.length ? 'No match — the name is used as typed' : 'No customers yet — add them in My Customers'}</li>
          ) : shown.map((c, n) => (
            <li key={c.id} role="option" aria-selected={n === at} className={n === at ? 'is-at' : ''}
              onMouseEnter={() => setAt(n)} onMouseDown={(e) => { e.preventDefault(); pick(c) }}>
              <b>{c.name}</b>
              <small>{[c.code, c.company, c.mobile, c.city_name].filter(Boolean).join(' · ')}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}


const SvgSave = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M7 3v5h8V3M7 21v-7h10v7" />
  </svg>
)
const SvgSend = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" />
  </svg>
)
const SvgEye = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />
  </svg>
)

/** Save as Draft, with Save & Send and Preview under the arrow. */
function SaveMenu({ busy, decided, label, onSave, onSend, onPreview }: {
  busy: boolean
  decided: boolean
  label: string
  onSave: () => void
  onSend: () => void
  onPreview: () => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  const act = (fn: () => void) => () => { setOpen(false); fn() }
  return (
    <div className="qe-save" ref={root}>
      <button className="btn btn-primary qe-save-main" onClick={onSave} disabled={busy || decided}>
        <SvgSave /> {label}
      </button>
      <button className="btn btn-primary qe-save-caret" onClick={() => setOpen((v) => !v)} disabled={busy}
        aria-haspopup="menu" aria-expanded={open} aria-label="More save options">
        <IconChevronDown size={15} />
      </button>
      {open && (
        <div className="qe-save-menu" role="menu">
          <button role="menuitem" className="is-main" onClick={act(onSave)} disabled={decided}><SvgSave /> {label}</button>
          <button role="menuitem" onClick={act(onSend)} disabled={decided}><SvgSend /> Save &amp; Send</button>
          <hr />
          <button role="menuitem" onClick={act(onPreview)}><SvgEye /> Preview</button>
          <p>Send and Preview save the quotation first. Send marks it Sent and opens the document to print or share as PDF.</p>
        </div>
      )}
    </div>
  )
}
