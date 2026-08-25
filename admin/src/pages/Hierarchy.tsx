import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import '../styles/org.css'
import { api } from '../lib/api'
import { useQuery } from '../lib/useQuery'
import { canAdminister, useAuth } from '../lib/auth'
import type { HierarchyNode } from '../lib/types'
import { Loading, ErrorNote } from '../components/ui'

interface HierarchyResponse {
  roots: HierarchyNode[]
  scoped: boolean
}

interface AssignResult {
  updated: number
  rejected: string[]
  message: string
}

/** Everyone in the tree, depth-first, with the manager they currently sit under. */
function flatten(
  nodes: HierarchyNode[],
  managerId: string | null = null,
): Array<{ node: HierarchyNode; managerId: string | null }> {
  return nodes.flatMap((node) => [
    { node, managerId },
    ...flatten(node.reports, node.id),
  ])
}

/** A person plus everyone beneath them — the set that cannot be their manager. */
function subtreeIds(node: HierarchyNode): Set<string> {
  const ids = new Set<string>([node.id])
  for (const child of node.reports) {
    for (const id of subtreeIds(child)) ids.add(id)
  }
  return ids
}

export default function Hierarchy() {
  const { user } = useAuth()
  const { data, error, loading, reload } = useQuery<HierarchyResponse>('hierarchy', () =>
    api.get<HierarchyResponse>('/org/hierarchy'),
  )
  const [query, setQuery] = useState('')
  // The person whose manager is being changed, or null when the picker is shut.
  const [editing, setEditing] = useState<HierarchyNode | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  // Mirrors require_admin on /org/assign. Gating this on owner alone would be
  // decoration — an admin can still call the endpoint — and admins already own
  // departments, teams and designations on the org structure page.
  const editable = canAdminister(user) && !data?.scoped

  const everyone = useMemo(() => (data ? flatten(data.roots) : []), [data])

  async function assign(userId: string, managerId: string | null) {
    setBusy(true)
    setFailure(null)
    setNote(null)
    try {
      const result = await api.post<AssignResult>('/org/assign', {
        user_ids: [userId],
        ...(managerId ? { manager_id: managerId } : { clear_manager: true }),
      })
      // The server rejects individual moves that would close a loop. The picker
      // already hides those, but the tree in this browser can be minutes old,
      // so the authoritative answer still has to be shown rather than assumed.
      if (result.rejected.length > 0) setFailure(result.message)
      else setNote(result.message === 'Done.' ? 'Reporting line updated.' : result.message)
      setEditing(null)
      reload()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'Could not update the reporting line.')
    } finally {
      setBusy(false)
    }
  }

  if (error) return <ErrorNote>{error}</ErrorNote>
  if (loading || !data) return <Loading />

  const needle = query.trim().toLowerCase()

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Reporting hierarchy</h1>
          <p className="page-sub">
            {editable
              ? 'Who reports to whom. Change a line here and the chart rebuilds itself.'
              : 'Who reports to whom.'}
          </p>
        </div>
      </div>

      {data.scoped && (
        <div className="notice" style={{ marginBottom: 16 }}>
          You are seeing your own reporting line. Administrators see the whole company.
        </div>
      )}

      {note && (
        <div className="notice notice-ok" style={{ marginBottom: 16 }} role="status">
          {note}
        </div>
      )}
      {failure && (
        <div style={{ marginBottom: 16 }}>
          <ErrorNote>{failure}</ErrorNote>
        </div>
      )}

      <div className="filter-row">
        <input
          type="search"
          placeholder="Highlight a person…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ minWidth: 260 }}
        />
        {editable && (
          <span className="muted-sm" style={{ marginLeft: 'auto' }}>
            {everyone.filter((e) => e.managerId === null).length} at the top ·{' '}
            {everyone.length} people
          </span>
        )}
      </div>

      <section className="card">
        {data.roots.length === 0 ? (
          <p className="empty">
            No employees yet. Add people first and they appear here, all at the top level
            until you give them a manager.
          </p>
        ) : (
          <ul className="tree">
            {data.roots.map((node) => (
              <TreeNode
                key={node.id}
                node={node}
                depth={0}
                needle={needle}
                editable={editable}
                busy={busy}
                onChangeManager={setEditing}
                onClearManager={(n) => {
                  if (
                    window.confirm(
                      `Move ${n.name} to the top level?\n\n` +
                        'They stop reporting to anyone. Their own reports stay with them.',
                    )
                  ) {
                    void assign(n.id, null)
                  }
                }}
                hasManager={false}
              />
            ))}
          </ul>
        )}
      </section>

      {editing && (
        <ManagerPicker
          person={editing}
          everyone={everyone}
          busy={busy}
          onCancel={() => setEditing(null)}
          onPick={(managerId) => void assign(editing.id, managerId)}
        />
      )}
    </div>
  )
}

function matches(node: HierarchyNode, needle: string): boolean {
  if (!needle) return false
  return (
    node.name.toLowerCase().includes(needle) ||
    node.email.toLowerCase().includes(needle) ||
    (node.team ?? '').toLowerCase().includes(needle) ||
    (node.designation ?? '').toLowerCase().includes(needle)
  )
}

function subtreeMatches(node: HierarchyNode, needle: string): boolean {
  return matches(node, needle) || node.reports.some((child) => subtreeMatches(child, needle))
}

function TreeNode({
  node,
  depth,
  needle,
  editable,
  busy,
  onChangeManager,
  onClearManager,
  hasManager,
}: {
  node: HierarchyNode
  depth: number
  needle: string
  editable: boolean
  busy: boolean
  onChangeManager: (node: HierarchyNode) => void
  onClearManager: (node: HierarchyNode) => void
  hasManager: boolean
}) {
  // Deep branches start collapsed so a 300-person company is not a wall of
  // names — but a search result forces its ancestors open, otherwise the match
  // is hidden behind a collapsed parent.
  const [open, setOpen] = useState(depth < 2)
  const hit = matches(node, needle)
  const expanded = open || (needle !== '' && subtreeMatches(node, needle))
  const hasReports = node.reports.length > 0

  return (
    <li className="tree-item">
      <div className={`tree-row ${hit ? 'tree-hit' : ''}`}>
        <button
          className="tree-toggle"
          onClick={() => setOpen((v) => !v)}
          disabled={!hasReports}
          aria-expanded={hasReports ? expanded : undefined}
          aria-label={hasReports ? (expanded ? 'Collapse' : 'Expand') : undefined}
        >
          {hasReports ? (expanded ? '−' : '+') : '·'}
        </button>

        <span className="tree-avatar" aria-hidden="true">
          {node.name.slice(0, 1).toUpperCase()}
        </span>

        <span className="tree-body">
          <Link className="tree-name" to={`/employees/${node.id}`}>
            {node.name}
          </Link>
          <span className="tree-meta">
            {[node.designation, node.team, node.department].filter(Boolean).join(' · ') ||
              node.email}
          </span>
        </span>

        <span className="tree-tags">
          {!node.is_active && <span className="badge">inactive</span>}
          {node.role !== 'employee' && <span className="badge">{node.role}</span>}
          {hasReports && (
            <span className="badge" title="Total people beneath this person">
              {node.headcount - 1} report{node.headcount - 1 === 1 ? '' : 's'}
            </span>
          )}
        </span>

        {editable && (
          // Kept in the DOM rather than mounted on hover so they are reachable
          // by keyboard and by a screen reader; CSS fades them in on hover or
          // focus-within, which a hover-only mount cannot do.
          <span className="tree-actions">
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() => onChangeManager(node)}
              title={`Change who ${node.name} reports to`}
            >
              {hasManager ? 'Change manager' : 'Set manager'}
            </button>
            {hasManager && (
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={() => onClearManager(node)}
                title={`Move ${node.name} to the top level`}
              >
                Detach
              </button>
            )}
          </span>
        )}
      </div>

      {hasReports && expanded && (
        <ul className="tree">
          {node.reports.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              needle={needle}
              editable={editable}
              busy={busy}
              onChangeManager={onChangeManager}
              onClearManager={onClearManager}
              hasManager
            />
          ))}
        </ul>
      )}
    </li>
  )
}

function ManagerPicker({
  person,
  everyone,
  busy,
  onCancel,
  onPick,
}: {
  person: HierarchyNode
  everyone: Array<{ node: HierarchyNode; managerId: string | null }>
  busy: boolean
  onCancel: () => void
  onPick: (managerId: string | null) => void
}) {
  const [search, setSearch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  // Nobody in this person's own subtree can manage them — that is precisely the
  // loop the server rejects. Excluding them here means the operator never picks
  // an option that cannot work, instead of picking one and being told no.
  const excluded = useMemo(() => subtreeIds(person), [person])
  const currentManagerId = everyone.find((e) => e.node.id === person.id)?.managerId ?? null

  const needle = search.trim().toLowerCase()
  const candidates = everyone
    .filter((entry) => !excluded.has(entry.node.id))
    .filter(
      (entry) =>
        !needle ||
        entry.node.name.toLowerCase().includes(needle) ||
        entry.node.email.toLowerCase().includes(needle) ||
        (entry.node.team ?? '').toLowerCase().includes(needle),
    )
    .slice(0, 200)

  return (
    <div className="hx-backdrop" onMouseDown={onCancel}>
      <div
        className="hx-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Choose a manager for ${person.name}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="hx-dialog-head">
          <h2 className="hx-dialog-title">Who does {person.name} report to?</h2>
          <p className="muted-sm">
            {excluded.size > 1
              ? `${excluded.size - 1} person(s) below them are hidden — reporting to your own report would be a loop.`
              : 'Anyone in the company can be their manager.'}
          </p>
        </div>

        <input
          ref={inputRef}
          type="search"
          className="hx-search"
          placeholder="Search by name, email or team…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="hx-list">
          {currentManagerId && (
            <button
              className="hx-option hx-option-clear"
              disabled={busy}
              onClick={() => onPick(null)}
            >
              <span className="hx-option-name">Nobody — move to the top level</span>
              <span className="hx-option-meta">Their own reports stay with them</span>
            </button>
          )}

          {candidates.length === 0 ? (
            <p className="empty">No match.</p>
          ) : (
            candidates.map(({ node }) => {
              const current = node.id === currentManagerId
              return (
                <button
                  key={node.id}
                  className={`hx-option ${current ? 'hx-option-current' : ''}`}
                  disabled={busy || current}
                  onClick={() => onPick(node.id)}
                >
                  <span className="hx-option-name">
                    {node.name}
                    {current && <span className="badge">current</span>}
                  </span>
                  <span className="hx-option-meta">
                    {[node.designation, node.team, node.email].filter(Boolean)[0]}
                  </span>
                </button>
              )
            })
          )}
        </div>

        <div className="hx-dialog-foot">
          <button className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
