/**
 * Opportunity pipeline: every opportunity as a card in its stage column.
 *
 * Drag a card to another column, or use the stage box on the card (which also
 * works from the keyboard and on a phone). Create opens the same opportunity
 * form the lead page uses, after choosing the lead it is for.
 */

import { useState, type DragEvent } from 'react'
import '../../styles/crm.css'
import { ErrorNote, Loading } from '../../components/ui'
import { IconPlus } from '../../components/Icons'
import { useQuery } from '../../lib/useQuery'
import { api } from '../../lib/api'
import { crm, crmError, rupees, type Lead, type Opportunity, type OpportunityStage } from './api'
import { OpportunityForm } from './OpportunityForm'
import { Dialog, Field, LostReasonSelect } from './parts'

const STAGES: Array<{ key: OpportunityStage; label: string }> = [
  { key: 'qualified', label: 'Qualified' },
  { key: 'proposal', label: 'Proposal' },
  { key: 'commit', label: 'Commit' },
  { key: 'won', label: 'Won' },
  { key: 'lost', label: 'Lost' },
]

export default function Pipeline() {
  const list = useQuery<Opportunity[]>('crm-pipeline', () => api.get<Opportunity[]>('/crm/opportunities'))
  const rows = list.data ?? []
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<OpportunityStage | null>(null)
  const [picking, setPicking] = useState(false)
  /* A move to Lost waits here until the reason is given. */
  const [losing, setLosing] = useState<Opportunity | null>(null)
  const [form, setForm] = useState<{ lead: Lead; opportunity: Opportunity | null } | null>(null)

  async function move(row: Opportunity, stage: OpportunityStage, lostReason?: string) {
    if (row.stage === stage) return
    if (stage === 'lost' && !lostReason) { setLosing(row); return }
    setError(null)
    try {
      await crm.setOpportunityStage(row.id, stage, lostReason)
      list.reload()
    } catch (err) {
      setError(crmError(err, 'That opportunity could not be moved'))
    }
  }

  async function edit(row: Opportunity) {
    setError(null)
    try {
      setForm({ lead: await crm.lead(row.lead_id), opportunity: row })
    } catch (err) {
      setError(crmError(err, 'That opportunity could not be opened'))
    }
  }

  function drop(event: DragEvent, stage: OpportunityStage) {
    event.preventDefault()
    setOver(null)
    const row = rows.find((r) => r.id === dragging)
    setDragging(null)
    if (row) void move(row, stage)
  }

  return (
    <div className="crm">
      <header className="hrd-hero">
        <div className="hrd-hero-text">
          <h1 className="hrd-title">Pipeline</h1>
          <p className="crm-sub">Drag an opportunity to the next stage as the deal moves.</p>
        </div>
        <button className="btn btn-primary" type="button" onClick={() => setPicking(true)}>
          <IconPlus size={15} /> Create
        </button>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}
      {list.error ? (
        <ErrorNote>{crmError(list.cause, 'Could not load the pipeline')}</ErrorNote>
      ) : !list.data ? (
        <Loading label="Loading pipeline…" />
      ) : (
        <div className="pipe-board">
          {STAGES.map(({ key, label }) => {
            const cards = rows.filter((r) => r.stage === key)
            const total = cards.reduce((sum, r) => sum + Number(r.expected_revenue), 0)
            const weighted = cards.reduce((sum, r) => sum + Number(r.expected_revenue) * r.probability / 100, 0)
            return (
              <section
                key={key}
                className={`pipe-col is-${key}${over === key ? ' is-over' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setOver(key) }}
                onDragLeave={() => setOver((o) => (o === key ? null : o))}
                onDrop={(e) => drop(e, key)}
                aria-label={`${label}, ${cards.length} opportunities`}
              >
                <header className="pipe-head">
                  <h2>{label}</h2>
                  <span className="pipe-count">{cards.length}</span>
                  <span className="pipe-total" title={key === 'won' || key === 'lost' ? undefined : `Weighted by probability: ${rupees(weighted)}`}>{rupees(total)}</span>
                </header>
                <div className="pipe-cards">
                  {cards.length === 0 && <p className="pipe-empty">No opportunities</p>}
                  {cards.map((row) => (
                    <article
                      key={row.id}
                      className={`pipe-card${dragging === row.id ? ' is-dragging' : ''}`}
                      draggable
                      onDragStart={(e) => { setDragging(row.id); e.dataTransfer.effectAllowed = 'move' }}
                      onDragEnd={() => { setDragging(null); setOver(null) }}
                    >
                      <button type="button" className="pipe-title" onClick={() => void edit(row)}>{row.title}</button>
                      <div className="pipe-sub">{row.customer_name ?? row.lead_name ?? '—'}</div>
                      <div className="pipe-money">{rupees(row.expected_revenue)}</div>
                      {row.stage === 'lost' && row.lost_reason && <div className="pipe-lost">Lost: {row.lost_reason}</div>}
                      <div className="pipe-foot">
                        <span className="crm-sub">{row.probability}%</span>
                        <select
                          className="pipe-stage"
                          value={row.stage}
                          aria-label={`Stage of ${row.title}`}
                          onChange={(e) => void move(row, e.target.value as OpportunityStage)}
                        >
                          {STAGES.map((s) => (
                            <option key={s.key} value={s.key}>{s.key === 'lost' ? 'Mark lost' : s.label}</option>
                          ))}
                        </select>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}

      {losing && (
        <LostDialog
          row={losing}
          onClose={() => setLosing(null)}
          onConfirm={(reason) => { const row = losing; setLosing(null); void move(row, 'lost', reason) }}
        />
      )}
      {picking && (
        <LeadPicker
          taken={new Set(rows.map((r) => r.lead_id))}
          onClose={() => setPicking(false)}
          onPick={(lead) => { setPicking(false); setForm({ lead, opportunity: null }) }}
        />
      )}
      {form && (
        <OpportunityForm
          lead={form.lead}
          opportunity={form.opportunity}
          onClose={() => setForm(null)}
          onSaved={() => { setForm(null); list.reload() }}
        />
      )}
    </div>
  )
}

/** An opportunity belongs to a lead, so Create starts by choosing one. */
function LeadPicker({ onClose, onPick, taken }: { onClose: () => void; onPick: (lead: Lead) => void; taken: Set<string> }) {
  const leads = useQuery('crm-pipeline-leads', () => crm.leads({ page_size: 200 }))
  const [id, setId] = useState('')
  const chosen = leads.data?.rows.find((l) => l.id === id)
  return (
    <Dialog
      title="Create opportunity"
      subtitle="Choose the lead this opportunity is for. A lead has one opportunity, so leads that already have one are not listed."
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="button" disabled={!chosen} onClick={() => chosen && onPick(chosen)}>
            Next
          </button>
        </>
      }
    >
      <div className="crm-form">
        <Field label="Lead" wide required>
          <select value={id} onChange={(e) => setId(e.target.value)} disabled={!leads.data}>
            <option value="">{leads.data ? 'Select lead' : 'Loading…'}</option>
            {(leads.data?.rows ?? []).filter((l) => !taken.has(l.id)).map((l) => (
              <option key={l.id} value={l.id}>{l.name}{l.company ? ` · ${l.company}` : ''} · {l.mobile}</option>
            ))}
          </select>
        </Field>
      </div>
    </Dialog>
  )
}

/** Moving a deal to Lost asks why, so the reason is on the record. */
function LostDialog({ row, onClose, onConfirm }: { row: Opportunity; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('')
  return (
    <Dialog
      title="Mark as lost"
      subtitle={row.title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="button" disabled={!reason} onClick={() => onConfirm(reason)}>Mark lost</button>
        </>
      }
    >
      <div className="crm-form">
        <Field label="Reason lost" wide required>
          <LostReasonSelect value={reason} onChange={setReason} autoFocus />
        </Field>
      </div>
    </Dialog>
  )
}
