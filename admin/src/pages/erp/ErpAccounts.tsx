/* Master -> ERP Master -> List of Accounts: the chart of accounts. Account groups
 * as a tree with their codes, the ledgers under them, and balances rolled up.
 * A group holds no postings itself — it is a heading. */

import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '../../lib/useQuery'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconChevronDown, IconChevronRight, IconEdit, IconPlus, IconSearch, IconTrash } from '../../components/Icons'
import { Dialog, Field, useAccess, useRun } from './parts'
import { erp, rupees, type AccountNode, type AccountTree, type Ledger } from './api'
import { LedgerForm } from './ErpLedgers'

const TILES: Array<{ key: string; label: string }> = [
  { key: 'assets', label: 'Assets' }, { key: 'liabilities', label: 'Liabilities' },
  { key: 'income', label: 'Income' }, { key: 'expenses', label: 'Expenses' },
]

const money = (signed: string) => {
  const n = Number(signed || 0)
  return n === 0 ? '—' : `${rupees(Math.abs(n))} ${n > 0 ? 'Dr' : 'Cr'}`
}

const Lock = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label="Standard account — locked" style={{ opacity: 0.55 }}>
    <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
)
const ArchiveIcon = ({ undo }: { undo?: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" />
    {undo ? <path d="M10 14l2-2 2 2M12 12v5" /> : <path d="M10 13h4" />}
  </svg>
)

type Row =
  | { kind: 'group'; node: AccountNode; depth: number }
  | { kind: 'ledger'; id: string; name: string; code: string; balance: string; active: boolean; depth: number; groupId: string | null; groupName: string }

export default function Accounts() {
  const { can } = useAccess()
  const manage = can('can_manage_erp_masters')
  const [showArchived, setShowArchived] = useState(false)
  const [q, setQ] = useState('')
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const tree = useQuery<AccountTree>(`erp-account-tree-${showArchived}`, () => erp.accountTree(showArchived))
  const [dialog, setDialog] = useState<
    | { t: 'new'; group: AccountNode | null }
    | { t: 'ledger'; ledger: Ledger }
    | { t: 'edit'; group: AccountNode }
    | null
  >(null)
  const acting = useRun(() => tree.reload())

  const data = tree.data
  const rows = useMemo<Row[]>(() => {
    if (!data) return []
    const kids = new Map<string | null, AccountNode[]>()
    data.groups.forEach((g) => kids.set(g.parent_id, [...(kids.get(g.parent_id) ?? []), g]))
    const byGroup = new Map<string | null, typeof data.ledgers>()
    data.ledgers.forEach((l) => byGroup.set(l.group_id, [...(byGroup.get(l.group_id) ?? []), l]))
    const out: Row[] = []
    const walk = (parent: string | null, depth: number) => {
      for (const g of kids.get(parent) ?? []) {
        out.push({ kind: 'group', node: g, depth })
        if (closed.has(g.id)) continue
        walk(g.id, depth + 1)
        for (const l of byGroup.get(g.id) ?? []) {
          out.push({ kind: 'ledger', id: l.id, name: l.name, code: l.code, balance: l.balance, active: l.is_active, depth: depth + 1, groupId: g.id, groupName: g.name })
        }
      }
    }
    walk(null, 0)
    const loose = byGroup.get(null) ?? []
    loose.forEach((l) => out.push({ kind: 'ledger', id: l.id, name: l.name, code: l.code, balance: l.balance, active: l.is_active, depth: 0, groupId: null, groupName: l.account_group }))
    return out
  }, [data, closed])

  const needle = q.trim().toLowerCase()
  const shown = useMemo(() => {
    if (!needle) return rows
    // Keep a match and the headings above it, so a hit still has its place in the chart.
    const keep = new Set<number>()
    rows.forEach((r, i) => {
      const name = r.kind === 'group' ? r.node.name : r.name
      const code = r.kind === 'group' ? r.node.code ?? '' : r.code
      if (!`${name} ${code}`.toLowerCase().includes(needle)) return
      keep.add(i)
      let depth = r.depth
      for (let j = i - 1; j >= 0 && depth > 0; j--) {
        if (rows[j].kind === 'group' && rows[j].depth < depth) { keep.add(j); depth = rows[j].depth }
      }
    })
    return rows.filter((_, i) => keep.has(i))
  }, [rows, needle])

  const toggle = (id: string) => setClosed((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const done = () => { setDialog(null); tree.reload() }

  function removeGroup(g: AccountNode) {
    if (!window.confirm(`Delete the account group “${g.name}”? This cannot be undone.`)) return
    void acting.run(() => erp.deleteAccountGroup(g.id), 'That group could not be deleted')
  }
  function removeLedger(id: string, name: string) {
    if (!window.confirm(`Delete the ledger “${name}”? This cannot be undone.`)) return
    void acting.run(() => erp.deleteLedger(id), 'That ledger could not be deleted')
  }
  async function editLedger(id: string) {
    try { setDialog({ t: 'ledger', ledger: await erp.ledger(id) }) } catch { /* the list reloads on the next action */ }
  }

  const btn = (title: string, onClick: () => void, icon: ReactNode, danger = false) => (
    <button className={`crm-icon-btn${danger ? ' crm-icon-danger' : ''}`} title={title} aria-label={title} disabled={acting.busy} onClick={onClick}>{icon}</button>
  )

  return (
    <>
      {data && (
        <div className="vdl-kpis" style={{ marginBottom: 12 }}>
          {TILES.map((t) => {
            const v = data.totals[t.key]
            return (
              <div key={t.key} className="vdl-kpi" style={{ cursor: 'default' }}>
                <span className="vdl-kpi-label">{t.label}</span>
                <b className="vdl-kpi-value">{v ? money(v.balance) : '—'}</b>
                <small className="vdl-kpi-sub">{v?.accounts ?? 0} accounts</small>
              </div>
            )
          })}
        </div>
      )}

      <div className="crm-bar itl-bar">
        <div className="crm-search">
          <IconSearch size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or code" aria-label="Search accounts" />
        </div>
        {data && <span className="itl-count">{data.ledgers.length + data.groups.length} accounts</span>}
        <div className="crm-push" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <label className="crm-check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
          {manage && <button className="btn btn-primary" onClick={() => setDialog({ t: 'new', group: null })}><IconPlus size={15} /> New account</button>}
        </div>
      </div>
      {tree.error && <ErrorNote>{tree.error}</ErrorNote>}
      {acting.error && <div style={{ marginBottom: 10 }}><ErrorNote>{acting.error}</ErrorNote></div>}

      <section className="card itl-card">
        {!data ? <Loading /> : shown.length === 0 ? (
          <EmptyState icon={<IconSearch size={22} />} title="Nothing matches" body="Change the search." />
        ) : (
          <div className="table-wrap"><table className="itl">
            <thead><tr><th>Account</th><th>Code</th><th className="crm-nowrap" style={{ textAlign: 'right' }}>Balance</th>{manage && <th className="itl-c-act" />}</tr></thead>
            <tbody>
              {shown.map((r) => {
                const isGroup = r.kind === 'group'
                const archived = isGroup ? r.node.is_archived : !r.active
                return (
                  <tr key={`${r.kind}-${isGroup ? r.node.id : r.id}`} style={archived ? { opacity: 0.55 } : undefined}>
                    <td style={{ paddingLeft: 12 + r.depth * 22 }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        {isGroup ? (
                          <button type="button" className="crm-icon-btn" onClick={() => toggle(r.node.id)} aria-label={closed.has(r.node.id) ? 'Expand' : 'Collapse'}>
                            {closed.has(r.node.id) ? <IconChevronRight size={13} /> : <IconChevronDown size={13} />}
                          </button>
                        ) : <span style={{ width: 28 }} />}
                        <span style={{ fontWeight: isGroup && r.depth < 2 ? 700 : isGroup ? 600 : 400 }}>{isGroup ? r.node.name : r.name}</span>
                        {isGroup && r.node.is_system && <Lock />}
                        {archived && <span className="muted-sm">archived</span>}
                      </span>
                    </td>
                    <td className="crm-nowrap muted-sm">{isGroup ? r.node.code : r.code}</td>
                    <td className="crm-nowrap" style={{ textAlign: 'right' }}>{money(isGroup ? r.node.balance : r.balance)}</td>
                    {manage && (
                      <td className="itl-c-act">
                        <div className="crm-row-actions itl-actions">
                          {isGroup && !r.node.is_archived && (
                            <button className="btn btn-sm" disabled={acting.busy} onClick={() => setDialog({ t: 'new', group: r.node })}>
                              <IconPlus size={13} /> Add
                            </button>
                          )}
                          {btn('Edit', () => (isGroup ? setDialog({ t: 'edit', group: r.node }) : void editLedger(r.id)), <IconEdit size={14} />)}
                          {isGroup
                            ? !r.node.is_system && btn(archived ? 'Restore' : 'Archive',
                                () => void acting.run(() => erp.archiveAccountGroup(r.node.id, !archived), 'That group could not be changed'), <ArchiveIcon undo={archived} />)
                            : btn(archived ? 'Restore' : 'Archive',
                                () => void acting.run(() => erp.archiveLedger(r.id, !archived), 'That ledger could not be changed'), <ArchiveIcon undo={archived} />)}
                          {isGroup
                            ? !r.node.is_system && btn('Delete', () => removeGroup(r.node), <IconTrash size={14} />, true)
                            : btn('Delete', () => removeLedger(r.id, r.name), <IconTrash size={14} />, true)}
                        </div>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table></div>
        )}
      </section>

      <p className="muted-sm" style={{ margin: '14px 4px 0', lineHeight: 1.6 }}>
        <b><Lock /> What the lock means.</b> A locked account is one the posting engine finds by a fixed system code — Sundry Debtors,
        Output CGST, Cash-in-Hand. <b>Rename and renumber them freely</b>: call Sundry Debtors whatever your business calls it and every
        invoice still posts to the right place. They cannot be deleted or archived, because removing one would stop every document that uses it.
        Anything with a posting behind it is archived rather than deleted — history is the product.
      </p>

      {dialog?.t === 'new' && data && (
        <NewAccountDialog groups={data.groups} ledgers={data.ledgers} group={dialog.group}
                          onClose={() => setDialog(null)} onDone={done} />
      )}
      {dialog?.t === 'ledger' && (
        <LedgerForm ledger={dialog.ledger} known={[]} onClose={() => setDialog(null)} onSaved={done} />
      )}
      {dialog?.t === 'edit' && <EditGroupDialog group={dialog.group} onClose={() => setDialog(null)} onSaved={done} />}
    </>
  )
}

function EditGroupDialog({ group, onClose, onSaved }: { group: AccountNode; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(group.name)
  const [code, setCode] = useState(group.code ?? '')
  const { busy, error, run } = useRun()
  return (
    <Dialog narrow title="Edit account group" subtitle={group.is_system ? 'A standard group: rename and renumber it freely' : undefined} onClose={onClose}
            footer={<>
              {error && <span className="error">{error}</span>}
              <button className="btn crm-push" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || !name.trim()}
                      onClick={() => void run(async () => { await erp.updateAccountGroup(group.id, { name: name.trim(), code: code.trim() || null }); onSaved() }, 'That group could not be saved')}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </>}>
      <div style={{ display: 'grid', gap: 14, padding: '8px 24px 20px' }}>
        <Field label="Group name" required><input value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Code" hint="Its place in the chart, like 1100"><input value={code} maxLength={16} inputMode="numeric" onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Field>
      </div>
    </Dialog>
  )
}

const NATURE: Record<string, string> = { assets: 'asset', liabilities: 'liability', equity: 'equity', income: 'income', expenses: 'expense' }

/** "Add" on a group: one small form. Ticked as a group it is another heading; otherwise it is an account
 *  (a ledger) that takes postings. Its type is whatever the group above it is. */
function NewAccountDialog({ groups, ledgers, group, onClose, onDone }: {
  groups: AccountNode[]; ledgers: AccountTree['ledgers']; group: AccountNode | null; onClose: () => void; onDone: () => void
}) {
  const [underId, setUnderId] = useState(group?.id ?? '')
  const under = groups.find((g) => g.id === underId) ?? null
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [codeTouched, setCodeTouched] = useState(false)
  const [asGroup, setAsGroup] = useState(false)
  const { busy, error, run } = useRun()

  // The type is the top heading above the group: Assets, Liabilities, Equity, Income or Expenses.
  const top = (() => {
    let g = under
    while (g && g.parent_id) g = groups.find((x) => x.id === g!.parent_id) ?? null
    return g
  })()
  const nature = top ? NATURE[top.name.toLowerCase()] ?? top.name.toLowerCase() : ''

  // What the chart would number it next: one past the highest code already under the group.
  const suggested = (() => {
    if (!under?.code || !/^\d+$/.test(under.code)) return ''
    const base = Number(under.code)
    const step = base % 1000 === 0 ? 100 : base % 100 === 0 ? 10 : 1
    const used = [
      ...groups.filter((g) => g.parent_id === under.id).map((g) => g.code),
      ...ledgers.filter((l) => l.group_id === under.id).map((l) => l.code),
    ].filter((c): c is string => !!c && /^\d+$/.test(c) && Number(c) > base).map(Number)
    return String((used.length ? Math.max(...used) : base) + step)
  })()
  const shownCode = codeTouched ? code : suggested

  function add() {
    if (!under) return
    const chosen = shownCode.trim()
    void run(async () => {
      if (asGroup) await erp.addAccountGroup({ name: name.trim(), parent_id: under.id, code: chosen || null })
      else await erp.saveLedger({ name: name.trim(), account_group: under.name, code: chosen || null })
      onDone()
    }, 'That account could not be added')
  }

  return (
    <Dialog wide title={under ? `New account under ${under.name}` : 'New account'}
            subtitle={under ? `It will be ${nature}, like everything under ${under.name}` : 'Choose the group it belongs under'}
            onClose={onClose}
            footer={<>
              {error && <span className="error">{error}</span>}
              <button className="btn crm-push" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || !under || !name.trim()} onClick={add}>{busy ? 'Adding…' : 'Add account'}</button>
            </>}>
      <div style={{ display: 'grid', gap: 14, padding: '8px 24px 20px' }}>
        {!group && (
          <Field label="Under" required>
            <select value={underId} autoFocus onChange={(e) => setUnderId(e.target.value)}>
              <option value="">Choose a group</option>
              {groups.filter((g) => !g.is_archived).map((g) => <option key={g.id} value={g.id}>{'\u00a0\u00a0\u00a0\u00a0'.repeat(g.depth)}{g.name}</option>)}
            </select>
          </Field>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr', gap: 14 }}>
          <Field label="Code" hint="What it is numbered in your chart">
            <input value={shownCode} maxLength={16} onChange={(e) => { setCode(e.target.value.replace(/\D/g, '')); setCodeTouched(true) }} />
          </Field>
          <Field label="Name" required>
            <input value={name} maxLength={200} autoFocus={!!group} placeholder="Packing Material" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Type" hint="Taken from the group above">
            <input value={top?.name ?? ''} readOnly disabled className="lf-readonly" />
          </Field>
        </div>
        <label className="crm-check">
          <input type="checkbox" checked={asGroup} onChange={(e) => setAsGroup(e.target.checked)} />
          <span>This is a group — it totals what goes under it and takes no postings itself</span>
        </label>
      </div>
    </Dialog>
  )
}

