/* The Product / Service and Plan Master forms.
 *
 * Both lists outgrew the one-size master form: a product carries its price,
 * GST and HSN/SAC onto every quotation line, and a plan carries a billing
 * cycle that decides when the customer renews. So each has its own form, laid
 * out in the same sections as the ERP item form. */

import { useState } from 'react'
import { useQuery } from '../../lib/useQuery'
import { ErrorNote } from '../../components/ui'
import { IconBriefcase, IconCard, IconSheet } from '../../components/Icons'
import { crm, crmError } from '../crm/api'
import { Dialog, Field } from '../crm/parts'

type Row = Record<string, unknown>

interface FormProps {
  row: Row | null
  defaultParentId?: string
  onClose: () => void
  onSaved: () => void
}

export const PRODUCT_CATEGORIES = [
  { value: 'product', label: 'Product' },
  { value: 'service', label: 'Service' },
  { value: 'implementation', label: 'Implementation' },
  { value: 'support_amc', label: 'Support / AMC' },
  { value: 'recurring', label: 'Recurring / subscription' },
]

export const BILLING_CYCLES = [
  { value: 'monthly', label: 'Monthly', days: 30 },
  { value: 'quarterly', label: 'Quarterly', days: 91 },
  { value: 'half_yearly', label: 'Half-yearly', days: 182 },
  { value: 'yearly', label: 'Yearly', days: 365 },
  { value: 'one_time', label: 'One-time (no renewal)', days: 0 },
]

const GST_RATES = ['0', '5', '12', '18', '28']

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v))
/** "45000.00" from the API, shown as "45000"; blank stays blank. */
const amount = (v: unknown) => (v === null || v === undefined || v === '' ? '' : String(Number(v)))
const moneyOk = (v: string) => v.trim() === '' || /^\d{1,8}(\.\d{1,2})?$/.test(v.trim())
const rupee = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

function Section({ icon, title, aside, children }: {
  icon: React.ReactNode; title: string; aside?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <section className="itf-section">
      <header className="itf-head">
        <span className="itf-icon" aria-hidden>{icon}</span>
        <h3 className="itf-title">{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  )
}

function ActiveSwitch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label className="itf-switch">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span className="itf-switch-track" aria-hidden />
      <span>{label ?? (on ? 'Active' : 'Inactive')}</span>
    </label>
  )
}

async function persist(kind: string, row: Row | null, body: Row) {
  if (row) await crm.updateMaster(kind, String(row.id), body)
  else await crm.createMaster(kind, body)
}

/* ------------------------------------------------------------- product --- */

export function ProductForm({ row, onClose, onSaved }: FormProps) {
  const [f, setF] = useState({
    name: text(row?.name), category: text(row?.category) || 'product', unit: text(row?.unit) || 'Nos',
    rate: amount(row?.rate), gst_percent: row ? amount(row.gst_percent) : '18', hsn_sac: text(row?.hsn_sac),
    oem: text(row?.oem), description: text(row?.description), is_active: row ? row.is_active !== false : true,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (k: keyof typeof f, v: string | boolean) => setF((cur) => ({ ...cur, [k]: v }))

  const rateBad = !moneyOk(f.rate)
  const hsnBad = f.hsn_sac.trim() !== '' && !/^\d{4,8}$/.test(f.hsn_sac.trim())
  const rate = Number(f.rate || 0)
  const withGst = rate * (1 + Number(f.gst_percent || 0) / 100)
  const ready = f.name.trim() !== '' && !rateBad && !hsnBad

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await persist('products', row, {
        name: f.name.trim(), category: f.category, unit: f.unit.trim() || null, rate: f.rate.trim() || '0',
        gst_percent: f.gst_percent, hsn_sac: f.hsn_sac.trim() || null, oem: f.oem.trim() || null,
        description: f.description.trim() || null, is_active: f.is_active,
      })
      onSaved()
    } catch (err) {
      setError(crmError(err, 'The product could not be saved'))
      setBusy(false)
    }
  }

  return (
    <Dialog wide title={row ? `Edit ${text(row.name)}` : 'Add Product / Service'} onClose={onClose} footer={
      <>
        <ActiveSwitch on={f.is_active} onChange={(v) => set('is_active', v)} />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !ready} onClick={() => void save()}>
          {busy ? 'Saving…' : row ? 'Save changes' : 'Add product'}
        </button>
      </>
    }>
      <div className="itf">
        {error && <ErrorNote>{error}</ErrorNote>}
        <Section icon={<IconSheet size={15} />} title="Basic details">
          <div className="itf-grid">
            <Field label="Product name *" wide>
              <input value={f.name} maxLength={160} autoFocus={!row} placeholder="e.g. 10KVA Online UPS"
                onChange={(e) => set('name', e.target.value)} />
            </Field>
          </div>
        </Section>

        <Section icon={<IconCard size={15} />} title="Pricing & tax"
          aside={rate > 0 ? <span className="itf-margin">{rupee(Math.round(withGst * 100) / 100)} incl. GST</span> : undefined}>
          <div className="itf-grid">
            <Field label="Basic rate (₹)" hint={rateBad ? undefined : 'Optional — before GST'}>
              <span className={`itf-affix${rateBad ? ' is-bad' : ''}`}><i>₹</i>
                <input inputMode="decimal" value={f.rate} placeholder="e.g. 45000" onChange={(e) => set('rate', e.target.value)} />
              </span>
              {rateBad && <small className="ppf-err">Enter an amount like 45000 or 45000.50</small>}
            </Field>
            <Field label="GST %">
              <select value={f.gst_percent} onChange={(e) => set('gst_percent', e.target.value)}>
                {!GST_RATES.includes(f.gst_percent) && <option value={f.gst_percent}>{f.gst_percent}%</option>}
                {GST_RATES.map((g) => <option key={g} value={g}>{g}%</option>)}
              </select>
            </Field>
            <Field label="HSN / SAC code" hint={hsnBad ? undefined : '4 to 8 digits'} wide>
              <input value={f.hsn_sac} inputMode="numeric" maxLength={8} className={hsnBad ? 'is-bad' : ''}
                placeholder="e.g. 85044010"
                onChange={(e) => set('hsn_sac', e.target.value.replace(/\D/g, ''))} />
              {hsnBad && <small className="ppf-err">An HSN / SAC code is 4 to 8 digits</small>}
            </Field>
          </div>
        </Section>

        <Section icon={<IconBriefcase size={15} />} title="Description">
          <Field label="Description" hint="Carried onto the quotation line">
            <textarea rows={3} value={f.description} maxLength={4000} placeholder="Specifications, warranty, what is included…"
              onChange={(e) => set('description', e.target.value)} />
          </Field>
        </Section>
      </div>
    </Dialog>
  )
}

/* ---------------------------------------------------------------- plan --- */

export function PlanForm({ row, defaultParentId, onClose, onSaved }: FormProps) {
  const [f, setF] = useState({
    product_id: text(row?.product_id) || defaultParentId || '', name: text(row?.name), code: text(row?.code),
    price: amount(row?.price), gst_percent: amount(row?.gst_percent), billing_cycle: text(row?.billing_cycle) || 'yearly',
    duration_days: text(row?.duration_days), description: text(row?.description),
    is_active: row ? row.is_active !== false : true,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (k: keyof typeof f, v: string | boolean) => setF((cur) => ({ ...cur, [k]: v }))
  const products = useQuery<Array<{ id: string; name: string; is_active: boolean; gst_percent: string; category: string }>>(
    'crm-master-products', () => crm.masters('products'),
  )
  const options = (products.data ?? []).filter((p) => p.is_active || p.id === f.product_id)

  const priceBad = !moneyOk(f.price)
  const daysBad = f.duration_days.trim() !== '' && !(/^\d+$/.test(f.duration_days) && Number(f.duration_days) >= 1 && Number(f.duration_days) <= 36500)
  const cycle = BILLING_CYCLES.find((c) => c.value === f.billing_cycle) ?? BILLING_CYCLES[3]
  const term = Number(f.duration_days) || cycle.days
  const ready = Boolean(f.product_id) && f.name.trim() !== '' && !priceBad && !daysBad

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await persist('plans', row, {
        product_id: f.product_id, name: f.name.trim(), code: f.code.trim() || null, price: f.price.trim() || '0',
        gst_percent: f.gst_percent === '' ? null : f.gst_percent, billing_cycle: f.billing_cycle,
        duration_days: f.duration_days.trim() ? Number(f.duration_days) : null,
        description: f.description.trim() || null, is_active: f.is_active,
      })
      onSaved()
    } catch (err) {
      setError(crmError(err, 'The plan could not be saved'))
      setBusy(false)
    }
  }

  return (
    <Dialog wide title={row ? `Edit ${text(row.name)}` : 'Add Plan'} onClose={onClose} footer={
      <>
        <ActiveSwitch on={f.is_active} onChange={(v) => set('is_active', v)}
          label={f.is_active ? 'Active — offered when creating a lead' : 'Inactive — kept on leads that already hold it'} />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !ready} onClick={() => void save()}>
          {busy ? 'Saving…' : row ? 'Save changes' : 'Add plan'}
        </button>
      </>
    }>
      <div className="itf">
        {error && <ErrorNote>{error}</ErrorNote>}
        <Section icon={<IconSheet size={15} />} title="Plan details">
          <div className="itf-grid">
            <Field label="Product / service *" wide
              hint={options.length === 0 && products.data ? 'Add a product in Product / Service first' : 'The plan is only offered on leads with this product or service selected.'}>
              <select value={f.product_id} onChange={(e) => set('product_id', e.target.value)}>
                <option value="">{options.length ? 'Select product / service' : 'No products yet'}</option>
                {options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Plan name *">
              <input value={f.name} maxLength={120} autoFocus={!row} placeholder="e.g. Gold — 1 Year"
                onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Plan code" hint="Your own reference — optional">
              <input value={f.code} maxLength={40} placeholder="e.g. AMC-GOLD-12"
                onChange={(e) => set('code', e.target.value.toUpperCase())} />
            </Field>
          </div>
        </Section>

        <Section icon={<IconCard size={15} />} title="Pricing & term"
          aside={<span className="itf-margin">{cycle.value === 'one_time' && !f.duration_days ? 'No renewal' : `Renews every ${term} days`}</span>}>
          <div className="itf-grid">
            <Field label="Price">
              <span className={`itf-affix${priceBad ? ' is-bad' : ''}`}><i>₹</i>
                <input inputMode="decimal" value={f.price} placeholder="e.g. 4999" onChange={(e) => set('price', e.target.value)} />
              </span>
              {priceBad && <small className="ppf-err">Enter an amount like 4999 or 4999.50</small>}
            </Field>
            <Field label="Billing cycle">
              <select value={f.billing_cycle} onChange={(e) => set('billing_cycle', e.target.value)}>
                {BILLING_CYCLES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </Field>
            <Field label="Duration in days" hint={daysBad ? undefined : 'Only when the cycle does not describe it — a 45-day trial, say.'}>
              <span className={`itf-affix is-suffix${daysBad ? ' is-bad' : ''}`}>
                <input inputMode="numeric" value={f.duration_days} placeholder={cycle.days ? String(cycle.days) : 'e.g. 365'}
                  onChange={(e) => set('duration_days', e.target.value.replace(/\D/g, '').slice(0, 5))} />
                <i>days</i>
              </span>
              {daysBad && <small className="ppf-err">Between 1 and 36500 days</small>}
            </Field>
          </div>
        </Section>

        <Section icon={<IconBriefcase size={15} />} title="Description">
          <Field label="Description">
            <textarea rows={3} value={f.description} maxLength={2000} placeholder="e.g. On-site support, 4 preventive visits a year, spares extra"
              onChange={(e) => set('description', e.target.value)} />
          </Field>
        </Section>
      </div>
    </Dialog>
  )
}
