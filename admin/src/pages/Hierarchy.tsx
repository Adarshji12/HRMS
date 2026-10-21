import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import '../styles/orgchart.css'
/* The assign dialog is the picker shell org.css already owns — .hx-backdrop,
   .hx-dialog and its head and foot. Imported rather than re-declared so this
   dialog cannot drift from the four others in the console that use it. */
import '../styles/org.css'
import { api } from '../lib/api'
import { useQuery } from '../lib/useQuery'
import { canAdminister, useAuth } from '../lib/auth'
import type { HierarchyNode } from '../lib/types'
import { Avatar, ErrorNote, Loading } from '../components/ui'
import {
  IconChevronRight,
  IconClose,
  IconDownload,
  IconPlus,
  IconSearch,
  IconSitemap,
} from '../components/Icons'

/**
 * The reporting chart.
 *
 * This was an indented list, and an indented list is the wrong shape for the
 * question people bring to it. Nobody opens an org chart to read names in
 * order; they open it to see *shape* — how wide the top is, which director
 * carries nine people and which carries one, where a whole branch is missing a
 * manager. A list answers none of that until you have read all of it.
 *
 * So: cards on connectors, one branch per manager, with the count of everyone
 * beneath a card printed under it. Three things follow from that decision and
 * are worth stating, because each one is a constraint on every change here.
 *
 * **Two ways to do everything, always.** Dragging a card onto another card
 * reassigns a manager, because that is the gesture people reach for. It is
 * also invisible to a keyboard and to a screen reader, so every drag has a
 * twin in the card's own menu and in the Assign dialog. Never add a third
 * gesture without its twin.
 *
 * **The chart is the tree the server sent.** Roots are people with no manager.
 * Ones with reports are drawn; ones without are people nobody has placed yet,
 * and they go to the Unassigned panel rather than sitting in the chart as
 * fifty one-card columns that push the real tree off the screen. That is the
 * only rearranging this file does — no node is hidden, moved or invented.
 *
 * **A refused move is shown, not swallowed.** `/org/assign` rejects an
 * individual move that would close a loop, and answers with who it refused.
 * The picker hides those already, but the tree in this browser can be minutes
 * old, so the server's answer is what gets rendered.
 */

interface HierarchyResponse {
  roots: HierarchyNode[]
  scoped: boolean
}

interface AssignResult {
  updated: number
  rejected: string[]
  message: string
}

type Orientation = 'vertical' | 'horizontal'

const ZOOM_MIN = 0.4
const ZOOM_MAX = 1.6
const ZOOM_STEP = 0.15

/* ------------------------------------------------------------- helpers --- */

interface Flat {
  node: HierarchyNode
  managerId: string | null
  managerName: string | null
}

/** Everyone in the tree, depth-first, with the manager they sit under today. */
function flatten(
  nodes: HierarchyNode[],
  managerId: string | null = null,
  managerName: string | null = null,
): Flat[] {
  return nodes.flatMap((node) => [
    { node, managerId, managerName },
    ...flatten(node.reports, node.id, node.name),
  ])
}

/**
 * id → everyone at or beneath that id.
 *
 * Built once for the whole tree rather than per drag. It is what makes an
 * illegal drop impossible to start: a manager cannot be moved under their own
 * report, and the server refuses it anyway, but a drop target that lights up
 * and then fails is worse than one that never lit.
 */
function subtreeIndex(nodes: HierarchyNode[], into = new Map<string, Set<string>>()): Map<string, Set<string>> {
  for (const node of nodes) {
    subtreeIndex(node.reports, into)
    const ids = new Set<string>([node.id])
    for (const child of node.reports) {
      for (const id of into.get(child.id) ?? []) ids.add(id)
    }
    into.set(node.id, ids)
  }
  return into
}

function matches(node: HierarchyNode, needle: string): boolean {
  if (!needle) return false
  return (
    node.name.toLowerCase().includes(needle) ||
    node.email.toLowerCase().includes(needle) ||
    (node.employee_code ?? '').toLowerCase().includes(needle) ||
    (node.team ?? '').toLowerCase().includes(needle) ||
    (node.designation ?? '').toLowerCase().includes(needle)
  )
}

function subtreeMatches(node: HierarchyNode, needle: string): boolean {
  return matches(node, needle) || node.reports.some((child) => subtreeMatches(child, needle))
}

/** How many ranks deep the tree goes — one for a company of peers. */
function depthOf(nodes: HierarchyNode[]): number {
  return nodes.length ? 1 + Math.max(...nodes.map((node) => depthOf(node.reports))) : 0
}

/** The one line under a name on a card. Title first — it is what the chart is about. */
function caption(node: HierarchyNode): string {
  return node.designation ?? node.team ?? node.department ?? node.email
}

/* ============================================================== the page === */

export default function Hierarchy() {
  const { user } = useAuth()
  const { data, error, loading, reload } = useQuery<HierarchyResponse>('hierarchy', () =>
    api.get<HierarchyResponse>('/org/hierarchy'),
  )

  const [query, setQuery] = useState('')
  const [sideQuery, setSideQuery] = useState('')
  const [orientation, setOrientation] = useState<Orientation>('vertical')
  const [zoom, setZoom] = useState(1)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [dialog, setDialog] = useState<null | { manager: string | null | undefined; from?: string }>(
    null,
  )
  const [dragging, setDragging] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)

  /* Mirrors require_admin on /org/assign. Gating on owner alone would be
     decoration — an admin can call the endpoint either way. A manager reading
     their own scoped subtree gets the chart and none of the controls. */
  const editable = canAdminister(user) && !data?.scoped

  const everyone = useMemo(() => (data ? flatten(data.roots) : []), [data])
  const subtrees = useMemo(() => (data ? subtreeIndex(data.roots) : new Map()), [data])

  /* Roots with reports are the chart. Roots without are nobody's report and
     nobody's manager — the people this screen exists to place — and they go to
     the side panel. The fallback matters on day one: a company that has added
     employees and no reporting lines at all would otherwise get an empty chart
     beside a panel of everybody. */
  const { chartRoots, unassigned } = useMemo(() => {
    const roots = data?.roots ?? []
    const withReports = roots.filter((root) => root.reports.length > 0)
    if (withReports.length === 0) return { chartRoots: roots, unassigned: [] as HierarchyNode[] }
    return {
      chartRoots: withReports,
      unassigned: roots.filter((root) => root.reports.length === 0),
    }
  }, [data])

  /* A chart is centred on its widest rank, so the root sits over the middle of
     a row that is routinely wider than the screen — and a scroll box opens at
     the left, which puts the reader at the end of a branch instead of at the
     top of the company. Centre once the tree is in, and again whenever the
     orientation flips, which changes which axis overflows. */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.scrollLeft = Math.max(0, (canvas.scrollWidth - canvas.clientWidth) / 2)
  }, [data, orientation])

  async function assign(userIds: string[], managerId: string | null) {
    if (userIds.length === 0) return
    setBusy(true)
    setFailure(null)
    setNote(null)
    try {
      const result = await api.post<AssignResult>('/org/assign', {
        user_ids: userIds,
        ...(managerId ? { manager_id: managerId } : { clear_manager: true }),
      })
      if (result.rejected.length > 0) setFailure(result.message)
      else setNote(result.message === 'Done.' ? 'Reporting line updated.' : result.message)
      setDialog(null)
      reload()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'Could not update the reporting line.')
    } finally {
      setBusy(false)
      setDragging(null)
    }
  }

  function toggle(id: string) {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /* Built here rather than fetched: there is no org-chart export endpoint, and
     inventing one for four columns the browser already holds would be a round
     trip to reformat data that is on screen. */
  function exportCsv() {
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`
    const rows = [
      ['Employee code', 'Name', 'Designation', 'Team', 'Department', 'Reports to', 'Total beneath'],
      ...everyone.map((entry) => [
        entry.node.employee_code ?? '',
        entry.node.name,
        entry.node.designation ?? '',
        entry.node.team ?? '',
        entry.node.department ?? '',
        entry.managerName ?? '',
        String(entry.node.headcount - 1),
      ]),
    ]
    const blob = new Blob([rows.map((row) => row.map(escape).join(',')).join('\r\n')], {
      type: 'text/csv;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'reporting-hierarchy.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  if (error) return <ErrorNote>{error}</ErrorNote>
  if (loading || !data) return <Loading />

  const needle = query.trim().toLowerCase()
  const sideNeedle = sideQuery.trim().toLowerCase()
  const shown = unassigned.filter((node) => !sideNeedle || matches(node, sideNeedle))

  const managers = everyone.filter((entry) => entry.node.reports.length > 0)
  const span = managers.length
    ? (managers.reduce((n, entry) => n + entry.node.reports.length, 0) / managers.length)
    : 0
  const kpis = [
    { label: 'People', value: everyone.length, hint: 'In the chart and unassigned', tone: 'brand' },
    { label: 'Managers', value: managers.length, hint: 'With at least one report', tone: 'idle' },
    { label: 'Levels', value: depthOf(chartRoots), hint: 'From the top to the deepest report', tone: 'idle' },
    { label: 'Avg team size', value: span ? span.toFixed(1) : '—', hint: 'Direct reports per manager', tone: 'good' },
    { label: 'Unassigned', value: unassigned.length, hint: unassigned.length ? 'Need a manager' : 'Everyone is placed', tone: unassigned.length ? 'warn' : 'good' },
  ]

  return (
    <div className="hier">
      <div className="hier-hero">
        <div className="hier-hero-text">
          <span className="hier-eyebrow">Organisation</span>
          <h1 className="hier-title">Reporting hierarchy</h1>
          <p className="hier-sub">
            {editable
              ? 'Who reports to whom. Drag a card onto a manager, or use a card’s menu — the chart rebuilds itself either way.'
              : 'Who reports to whom.'}
          </p>
        </div>
        {editable && (
          <div className="hier-actions">
            <button className="btn" onClick={() => setDialog({ manager: null })}>
              Assign top-level manager
            </button>
            <button className="btn" onClick={() => setDialog({ manager: undefined, from: '' })}>
              Mass transfer
            </button>
            <button className="btn btn-primary" onClick={() => setDialog({ manager: undefined })}>
              <IconPlus size={15} /> Assign manager
            </button>
          </div>
        )}
      </div>

      <div className="hier-kpis" role="group" aria-label="Hierarchy summary">
        {kpis.map((kpi) => (
          <div key={kpi.label} className={`hier-kpi tone-${kpi.tone}`}>
            <span className="hier-kpi-label"><span className="hier-kpi-dot" aria-hidden />{kpi.label}</span>
            <span className="hier-kpi-value">{kpi.value}</span>
            <span className="hier-kpi-hint">{kpi.hint}</span>
          </div>
        ))}
      </div>

      {data.scoped && (
        <div className="notice" style={{ marginBottom: 14 }}>
          You are seeing your own reporting line. Administrators see the whole company.
        </div>
      )}
      {note && (
        <div className="notice notice-ok" style={{ marginBottom: 14 }} role="status">
          {note}
        </div>
      )}
      {failure && (
        <div style={{ marginBottom: 14 }}>
          <ErrorNote>{failure}</ErrorNote>
        </div>
      )}

      <div className="hier-work">
        <section className="card hier-stage">
          <div className="hier-toolbar">
            <label className="hier-search">
              <IconSearch size={15} />
              <input
                type="search"
                placeholder="Search the chart…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Search the chart"
              />
            </label>

            <div className="hier-tools">
              {/* Orientation, not a preference stored anywhere: it is a way of
                  looking at one chart for one minute — a deep tree reads left
                  to right, a wide one reads top down — and a remembered
                  setting would be a second thing to un-remember. */}
              <div className="hier-seg" role="group" aria-label="Chart direction">
                <button
                  className={`hier-seg-btn${orientation === 'vertical' ? ' is-on' : ''}`}
                  onClick={() => setOrientation('vertical')}
                  aria-pressed={orientation === 'vertical'}
                  title="Top to bottom"
                >
                  <IconSitemap size={15} />
                </button>
                <button
                  className={`hier-seg-btn${orientation === 'horizontal' ? ' is-on' : ''}`}
                  onClick={() => setOrientation('horizontal')}
                  aria-pressed={orientation === 'horizontal'}
                  title="Left to right"
                >
                  <IconSitemap size={15} className="hier-rotate" />
                </button>
              </div>

              <div className="hier-seg" role="group" aria-label="Expand or collapse">
                <button
                  className="hier-seg-btn hier-seg-text"
                  onClick={() => setCollapsed(new Set())}
                  title="Show everyone"
                >
                  Expand all
                </button>
                <button
                  className="hier-seg-btn hier-seg-text"
                  onClick={() =>
                    setCollapsed(new Set(chartRoots.flatMap((root) => root.reports.filter((r) => r.reports.length).map((r) => r.id))))
                  }
                  title="Show the top two levels only"
                >
                  Collapse
                </button>
              </div>

              <button className="btn" onClick={exportCsv} title="Download the whole chart as CSV">
                <IconDownload size={15} /> Export
              </button>
            </div>
          </div>

          {chartRoots.length === 0 ? (
            <p className="empty">
              No employees yet. Add people first and they appear here, all unassigned until you
              give them a manager.
            </p>
          ) : (
            <>
            {/* The zoom control is a sibling of the canvas, not a child: inside
                a box that scrolls it would travel with the chart, and a control
                that moves when you pan is not a control. */}
            <div className="hier-canvas" ref={canvasRef}>
              <div
                className={`oc oc-${orientation}`}
                style={{ ['--oc-zoom' as never]: zoom }}
              >
                {chartRoots.map((root) => (
                  <ChartNode
                    key={root.id}
                    node={root}
                    needle={needle}
                    editable={editable}
                    busy={busy}
                    collapsed={collapsed}
                    dragging={dragging}
                    subtrees={subtrees}
                    onToggle={toggle}
                    onDragPerson={setDragging}
                    onDrop={(personId, managerId) => void assign([personId], managerId)}
                    onAssign={(node) => setDialog({ manager: undefined, from: node.id })}
                    onDetach={(node) => void assign([node.id], null)}
                  />
                ))}
              </div>

            </div>

            <div className="hier-zoom" role="group" aria-label="Zoom">
              <button
                onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP))}
                disabled={zoom >= ZOOM_MAX}
                title="Zoom in"
                aria-label="Zoom in"
              >
                <IconPlus size={15} />
              </button>
              <button
                onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z - ZOOM_STEP))}
                disabled={zoom <= ZOOM_MIN}
                title="Zoom out"
                aria-label="Zoom out"
              >
                <span className="hier-minus" aria-hidden="true" />
              </button>
              {/* The readout is also the way back. A separate reset button
                  would be a third control for a value already on screen. */}
              <button
                className="hier-zoom-value"
                onClick={() => setZoom(1)}
                title="Back to 100%"
              >
                {Math.round(zoom * 100)}%
              </button>
            </div>
            </>
          )}
        </section>

        <aside className="card hier-side">
          <div className="hier-side-head">
            <div>
              <h2 className="hier-side-title">Unassigned</h2>
              <span className="hier-side-sub">No manager yet</span>
            </div>
            <span className={`hier-side-count${unassigned.length ? ' is-warn' : ''}`}>{unassigned.length}</span>
          </div>

          {editable && unassigned.length > 0 && (
            <p className="hier-hint">
              Drag a person onto a card to give them that manager, or use their menu.
            </p>
          )}

          {unassigned.length > 3 && (
            <label className="hier-search hier-search-side">
              <IconSearch size={15} />
              <input
                type="search"
                placeholder="Search…"
                value={sideQuery}
                onChange={(event) => setSideQuery(event.target.value)}
                aria-label="Search unassigned people"
              />
            </label>
          )}

          {unassigned.length === 0 ? (
            <p className="hier-side-empty">
              Everybody reports to somebody. People with no manager appear here.
            </p>
          ) : shown.length === 0 ? (
            <p className="hier-side-empty">Nobody here matches that.</p>
          ) : (
            <ul className="hier-side-list">
              {shown.map((node) => (
                <li key={node.id}>
                  <div
                    className={`hier-person${dragging === node.id ? ' is-dragging' : ''}`}
                    draggable={editable}
                    onDragStart={(event) => {
                      setDragging(node.id)
                      event.dataTransfer.setData('text/plain', node.id)
                      event.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragEnd={() => setDragging(null)}
                  >
                    <Avatar name={node.name} small />
                    <div className="hier-person-body">
                      <Link to={`/employees/${node.id}`} className="hier-person-name">
                        {node.name}
                      </Link>
                      <span className="hier-person-meta">
                        {node.employee_code ? `Emp ID · ${node.employee_code}` : caption(node)}
                      </span>
                    </div>
                    {editable && (
                      <button
                        className="hier-person-assign"
                        onClick={() => setDialog({ manager: undefined, from: node.id })}
                        title={`Give ${node.name} a manager`}
                        aria-label={`Give ${node.name} a manager`}
                      >
                        <IconChevronRight size={14} />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      {dialog && (
        <AssignDialog
          everyone={everyone}
          subtrees={subtrees}
          busy={busy}
          initialManager={dialog.manager}
          initialPerson={dialog.from}
          onCancel={() => setDialog(null)}
          onApply={(ids, managerId) => void assign(ids, managerId)}
        />
      )}
    </div>
  )
}

/* --------------------------------------------------------------- chart ---- */

function ChartNode({
  node,
  needle,
  editable,
  busy,
  collapsed,
  dragging,
  subtrees,
  onToggle,
  onDragPerson,
  onDrop,
  onAssign,
  onDetach,
}: {
  node: HierarchyNode
  needle: string
  editable: boolean
  busy: boolean
  collapsed: Set<string>
  dragging: string | null
  subtrees: Map<string, Set<string>>
  onToggle: (id: string) => void
  onDragPerson: (id: string | null) => void
  onDrop: (personId: string, managerId: string) => void
  onAssign: (node: HierarchyNode) => void
  onDetach: (node: HierarchyNode) => void
}) {
  /* A search forces its ancestors open. A match hidden behind a collapsed
     parent is the same as no match, and this is the one screen where somebody
     is looking for a person by name rather than reading the shape. */
  const open = !collapsed.has(node.id) || (needle !== '' && subtreeMatches(node, needle))
  const beneath = node.headcount - 1

  return (
    <div className="oc-branch">
      <NodeCard
        node={node}
        hit={matches(node, needle)}
        dimmed={needle !== '' && !subtreeMatches(node, needle)}
        editable={editable}
        busy={busy}
        dragging={dragging}
        subtrees={subtrees}
        onDragPerson={onDragPerson}
        onDrop={onDrop}
        onAssign={onAssign}
        onDetach={onDetach}
      />

      {beneath > 0 && (
        // The count doubles as the collapse control. Two separate affordances
        // — a number and a chevron — would be two things to explain about one
        // idea: how many are under here, and do you want to see them.
        <button
          className={`oc-count${open ? '' : ' is-closed'}`}
          onClick={() => onToggle(node.id)}
          aria-expanded={open}
          title={open ? `Hide the ${beneath} beneath ${node.name}` : `Show the ${beneath} beneath ${node.name}`}
        >
          {beneath}
        </button>
      )}

      {open && node.reports.length > 0 && (
        <div className="oc-children">
          {node.reports.map((child) => (
            <ChartNode
              key={child.id}
              node={child}
              needle={needle}
              editable={editable}
              busy={busy}
              collapsed={collapsed}
              dragging={dragging}
              subtrees={subtrees}
              onToggle={onToggle}
              onDragPerson={onDragPerson}
              onDrop={onDrop}
              onAssign={onAssign}
              onDetach={onDetach}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function NodeCard({
  node,
  hit,
  dimmed,
  editable,
  busy,
  dragging,
  subtrees,
  onDragPerson,
  onDrop,
  onAssign,
  onDetach,
}: {
  node: HierarchyNode
  hit: boolean
  dimmed: boolean
  editable: boolean
  busy: boolean
  dragging: string | null
  subtrees: Map<string, Set<string>>
  onDragPerson: (id: string | null) => void
  onDrop: (personId: string, managerId: string) => void
  onAssign: (node: HierarchyNode) => void
  onDetach: (node: HierarchyNode) => void
}) {
  const [menu, setMenu] = useState(false)
  const [over, setOver] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  /* Refused before the drop rather than after: dropping a manager onto one of
     their own reports would close a loop, the server would reject it, and a
     target that highlights and then fails teaches the wrong thing about what
     the chart allows. */
  const canAcceptDrop =
    editable &&
    dragging !== null &&
    dragging !== node.id &&
    !(subtrees.get(dragging)?.has(node.id) ?? false)

  useEffect(() => {
    if (!menu) return
    function onDown(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setMenu(false)
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenu(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  return (
    <div
      ref={wrapRef}
      className={
        'oc-card' +
        (hit ? ' is-hit' : '') +
        (dimmed ? ' is-dim' : '') +
        (over && canAcceptDrop ? ' is-target' : '') +
        (dragging === node.id ? ' is-dragging' : '') +
        (node.is_active ? '' : ' is-inactive')
      }
      draggable={editable}
      onDragStart={(event) => {
        onDragPerson(node.id)
        event.dataTransfer.setData('text/plain', node.id)
        event.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={() => onDragPerson(null)}
      onDragOver={(event) => {
        if (!canAcceptDrop) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false)
        if (!canAcceptDrop) return
        event.preventDefault()
        const personId = event.dataTransfer.getData('text/plain')
        if (personId && personId !== node.id) onDrop(personId, node.id)
      }}
    >
      <span className="oc-avatar"><Avatar name={node.name} /></span>
      <div className="oc-body">
        <Link to={`/employees/${node.id}`} className="oc-name">
          {node.name}
        </Link>
        <span className="oc-role">{caption(node)}</span>
        {(node.department || node.employee_code) && (
          <span className="oc-tags">
            {node.department && node.department !== caption(node) && <span className="oc-tag">{node.department}</span>}
            {node.employee_code && <span className="oc-tag oc-tag-code">{node.employee_code}</span>}
          </span>
        )}
      </div>
      {node.reports.length > 0 && (
        <div className="oc-foot">
          <span><strong>{node.reports.length}</strong> direct</span>
          <span><strong>{node.headcount - 1}</strong> total</span>
        </div>
      )}

      {!node.is_active && <span className="oc-flag">Inactive</span>}

      {editable && (
        <>
          <button
            className="oc-menu-btn"
            onClick={() => setMenu((v) => !v)}
            aria-expanded={menu}
            aria-label={`Actions for ${node.name}`}
            disabled={busy}
          >
            <span aria-hidden="true">⋮</span>
          </button>
          {menu && (
            <div className="oc-menu" role="menu">
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(false)
                  onAssign(node)
                }}
              >
                Change manager…
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(false)
                  onDetach(node)
                }}
              >
                Move to top level
              </button>
              <Link role="menuitem" to={`/employees/${node.id}`} onClick={() => setMenu(false)}>
                Open profile
              </Link>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* -------------------------------------------------------------- dialog ---- */

/**
 * One dialog behind all three toolbar buttons.
 *
 * They are the same operation with different halves filled in — move these
 * people under that manager — and three dialogs would be three places to fix
 * the cycle rule. "Assign manager" opens it empty, "Assign top-level manager"
 * opens it with the manager already set to nobody, and "Mass transfer" opens it
 * with a source filter so a whole team can be checked in one go.
 */
function AssignDialog({
  everyone,
  subtrees,
  busy,
  initialManager,
  initialPerson,
  onCancel,
  onApply,
}: {
  everyone: Flat[]
  subtrees: Map<string, Set<string>>
  busy: boolean
  /** `null` pre-selects "nobody"; `undefined` leaves the manager unchosen. */
  initialManager: string | null | undefined
  initialPerson?: string
  onCancel: () => void
  onApply: (ids: string[], managerId: string | null) => void
}) {
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(initialPerson ? [initialPerson] : []),
  )
  const [manager, setManager] = useState<string | null | undefined>(initialManager)
  const [peopleQuery, setPeopleQuery] = useState('')
  const [managerQuery, setManagerQuery] = useState('')
  /* The source filter only exists in the mass-transfer entry point, which is
     the one that opens with `from` set to the empty string — "a selection is
     coming, but not this one person". */
  const [source, setSource] = useState('')
  const massTransfer = initialPerson === ''

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const managers = useMemo(
    () => [...everyone].sort((a, b) => a.node.name.localeCompare(b.node.name)),
    [everyone],
  )

  /* Anybody at or beneath a checked person cannot be the new manager — that is
     the cycle rule, applied to the whole selection at once rather than one name
     at a time, so the list never offers a choice that would be half-rejected. */
  const blocked = useMemo(() => {
    const ids = new Set<string>()
    for (const id of picked) {
      for (const descendant of subtrees.get(id) ?? [id]) ids.add(descendant)
    }
    return ids
  }, [picked, subtrees])

  const peopleNeedle = peopleQuery.trim().toLowerCase()
  const managerNeedle = managerQuery.trim().toLowerCase()

  const people = everyone
    .filter((entry) => !massTransfer || !source || entry.managerId === source)
    .filter((entry) => !peopleNeedle || matches(entry.node, peopleNeedle))

  const chosenManager = manager ? everyone.find((e) => e.node.id === manager)?.node : undefined
  const ready = picked.size > 0 && manager !== undefined

  function toggle(id: string) {
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="hx-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="hx-dialog asg-dialog" role="dialog" aria-modal="true" aria-label="Assign manager">
        <div className="hx-dialog-head asg-head">
          <div>
            <h2 className="hx-dialog-title">
              {massTransfer ? 'Mass transfer' : 'Assign manager'}
            </h2>
            <p className="asg-sub">
              {massTransfer
                ? 'Pick a manager whose reports are moving, choose which of them, then choose where they go.'
                : 'Choose who moves, then who they report to.'}
            </p>
          </div>
          <button className="icon-btn" onClick={onCancel} aria-label="Close">
            <IconClose size={16} />
          </button>
        </div>

        <div className="asg-panes">
          <div className="asg-pane">
            <div className="asg-pane-head">
              <span className="asg-pane-title">Who moves</span>
              <span className="asg-pane-count">{picked.size} selected</span>
            </div>

            {massTransfer && (
              <select
                className="asg-source"
                value={source}
                onChange={(event) => {
                  setSource(event.target.value)
                  setPicked(new Set())
                }}
                aria-label="Currently reporting to"
              >
                <option value="">Anyone</option>
                {managers
                  .filter((entry) => entry.node.reports.length > 0)
                  .map((entry) => (
                    <option key={entry.node.id} value={entry.node.id}>
                      Reports of {entry.node.name}
                    </option>
                  ))}
              </select>
            )}

            <input
              type="search"
              className="asg-search"
              placeholder="Search people…"
              value={peopleQuery}
              onChange={(event) => setPeopleQuery(event.target.value)}
              aria-label="Search people to move"
            />

            <div className="asg-list">
              {people.length === 0 && <p className="asg-empty">Nobody matches that.</p>}
              {people.map((entry) => (
                <label className="asg-row" key={entry.node.id}>
                  <input
                    type="checkbox"
                    checked={picked.has(entry.node.id)}
                    onChange={() => toggle(entry.node.id)}
                  />
                  <Avatar name={entry.node.name} small />
                  <span className="asg-row-body">
                    <span className="asg-row-name">{entry.node.name}</span>
                    <span className="asg-row-meta">
                      {caption(entry.node)}
                      {entry.managerName ? ` · reports to ${entry.managerName}` : ' · no manager'}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="asg-pane">
            <div className="asg-pane-head">
              <span className="asg-pane-title">New manager</span>
            </div>

            <input
              type="search"
              className="asg-search"
              placeholder="Search managers…"
              value={managerQuery}
              onChange={(event) => setManagerQuery(event.target.value)}
              aria-label="Search for the new manager"
            />

            <div className="asg-list">
              {/* Separated from the names rather than sorted in among them:
                  "nobody" is a different kind of answer, and in a list of forty
                  people it would be missed. */}
              <label className={`asg-row asg-row-clear${manager === null ? ' is-on' : ''}`}>
                <input
                  type="radio"
                  name="asg-manager"
                  checked={manager === null}
                  onChange={() => setManager(null)}
                />
                <span className="asg-row-body">
                  <span className="asg-row-name">Nobody — top level</span>
                  <span className="asg-row-meta">They stop reporting to anyone.</span>
                </span>
              </label>

              {managers
                .filter((entry) => !managerNeedle || matches(entry.node, managerNeedle))
                .map((entry) => {
                  const off = blocked.has(entry.node.id)
                  return (
                    <label
                      className={`asg-row${manager === entry.node.id ? ' is-on' : ''}`}
                      key={entry.node.id}
                    >
                      <input
                        type="radio"
                        name="asg-manager"
                        checked={manager === entry.node.id}
                        disabled={off}
                        onChange={() => setManager(entry.node.id)}
                      />
                      <Avatar name={entry.node.name} small />
                      <span className="asg-row-body">
                        <span className="asg-row-name">{entry.node.name}</span>
                        <span className="asg-row-meta">
                          {off
                            ? 'In the selection, or beneath it — that would loop.'
                            : caption(entry.node)}
                        </span>
                      </span>
                    </label>
                  )
                })}
            </div>
          </div>
        </div>

        <div className="hx-dialog-foot asg-foot">
          <p className="asg-summary">
            {picked.size === 0
              ? 'Nobody selected yet.'
              : manager === undefined
                ? `${picked.size} selected — choose a manager.`
                : manager === null
                  ? `Move ${picked.size} to the top level.`
                  : `Move ${picked.size} under ${chosenManager?.name}.`}
          </p>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!ready || busy}
            onClick={() => onApply([...picked], manager ?? null)}
          >
            {busy ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  )
}
