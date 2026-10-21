/* ERP settings — the thresholds the PRD says must be configurable, not coded.
 *
 * Approval chains are not here: they live in Workflow, beside every other
 * flow's, so "who approves purchase orders over ₹5 lakh" is answered on the
 * same screen as "who approves leave". */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '../../lib/useQuery'
import { canAdminister, useAuth } from '../../lib/auth'
import { ErrorNote, Loading } from '../../components/ui'
import { erp, erpError, type ErpSettingsRow } from './api'
import { ErpPage, Field, Note, useRun } from './parts'

export default function ErpSettingsPage() {
  const { user } = useAuth()
  const q = useQuery('erp-settings', () => erp.settings())
  const [form, setForm] = useState<ErpSettingsRow | null>(null)
  const [saved, setSaved] = useState(false)
  const { busy, error, run } = useRun()
  useEffect(() => { if (q.data && !form) setForm(q.data) }, [q.data, form])
  const admin = canAdminister(user)
  if (q.error) return <ErpPage title="ERP settings"><ErrorNote>{erpError(q.cause, 'Could not load settings')}</ErrorNote></ErpPage>
  if (!form) return <ErpPage title="ERP settings"><Loading /></ErpPage>
  const set = <K extends keyof ErpSettingsRow>(k: K, v: ErpSettingsRow[K]) => { setForm({ ...form, [k]: v }); setSaved(false) }

  return (
    <ErpPage title="ERP settings" subtitle="Tolerances, credit rules and default terms">
      {!admin && <Note>Only an administrator can change these.</Note>}
      <Note tone="ok">
        Approval chains for requisitions, purchase orders, stock adjustments, sales orders and credit notes are set up in{' '}
        <Link to="/settings/approvals">Workflow</Link>. Without a chain, anybody holding the matching permission — other than the requester — approves.
        Permissions are granted in <Link to="/roles">Roles & Permission</Link>.
      </Note>
      <section className="card" style={{ padding: 20 }}>
        <div className="crm-form">
          <Field label="GRN over-receipt tolerance (%)" hint="0 = never accept more than was ordered">
            <input disabled={!admin} inputMode="decimal" value={form.grn_over_receipt_pct} onChange={(e) => set('grn_over_receipt_pct', e.target.value)} />
          </Field>
          <Field label="Default customer credit days">
            <input disabled={!admin} inputMode="numeric" value={String(form.default_credit_days)} onChange={(e) => set('default_credit_days', Number(e.target.value) || 0)} />
          </Field>
          <Field label="Block orders when an invoice is overdue by more than (days)" hint="0 turns the check off">
            <input disabled={!admin} inputMode="numeric" value={String(form.block_orders_overdue_days)} onChange={(e) => set('block_orders_overdue_days', Number(e.target.value) || 0)} />
          </Field>
          <label className="crm-check"><input disabled={!admin} type="checkbox" checked={form.allow_negative_stock} onChange={(e) => set('allow_negative_stock', e.target.checked)} /> Allow negative stock (not recommended)</label>
          <label className="crm-check"><input disabled={!admin} type="checkbox" checked={form.invoice_maker_checker} onChange={(e) => set('invoice_maker_checker', e.target.checked)} /> Invoices are posted by somebody other than whoever drafted them</label>
          <Field label="Default purchase order terms" wide>
            <textarea disabled={!admin} rows={3} value={form.po_terms ?? ''} onChange={(e) => set('po_terms', e.target.value)} />
          </Field>
          <Field label="Default invoice terms" wide>
            <textarea disabled={!admin} rows={3} value={form.invoice_terms ?? ''} onChange={(e) => set('invoice_terms', e.target.value)} />
          </Field>
        </div>
        {admin && (
          <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="btn btn-primary" disabled={busy} onClick={() => void run(async () => { setForm(await erp.saveSettings(form)); setSaved(true) })}>Save settings</button>
            {saved && <span className="crm-muted">Saved</span>}
            {error && <span className="error">{error}</span>}
          </div>
        )}
      </section>
    </ErpPage>
  )
}
