/* Master — every reference list in the workspace, on one screen of cards.
 *
 * Masters used to be tabs inside CRM Settings, which made "where do I add a
 * district" a question about which module owns geography. Here a card is a
 * family of lists (Geography, Lead, Service…) and each row opens that list's
 * table at /masters/<kind>. Lists that already have their own screens
 * (departments, ERP items and vendors) are linked from a card rather than
 * rebuilt, so there is still one place each is edited.
 *
 * Sales Master is not on this screen: it is worked in daily rather than set
 * once, so it has its own page (MasterHub.tsx) at /sales-master. Products and
 * plans are on the Lead Master card.
 *
 * Administrator-only, like the writes behind it: the dropdowns these fill are
 * readable by everybody, but editing them changes everybody's pipeline.
 */

import { useState, type ReactNode } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import '../../styles/crm.css'
import '../../styles/masterhub.css'
import { useQuery } from '../../lib/useQuery'
import {
  IconBuilding, IconChevronRight, IconFolder, IconGlobe, IconLifebuoy, IconSearch, IconUsers,
} from '../../components/Icons'
import { crm } from '../crm/api'
import { api } from '../../lib/api'
import { erp } from '../erp/api'
import { LISTS, MASTER_GROUPS, shortLabel, type MasterGroup } from './masterKit'
import MasterHub from './MasterHub'

const byKind = new Map(LISTS.map((list) => [list.kind, list]))

const GROUP_ICON: Record<string, ReactNode> = {
  geography: <IconGlobe size={18} />,
  lead: <IconUsers size={18} />,
  service: <IconLifebuoy size={18} />,
  organisation: <IconBuilding size={18} />,
  erp: <IconFolder size={18} />,
  ledger: <IconUsers size={18} />,
  inventory: <IconFolder size={18} />,
  update: <IconFolder size={18} />,
}

/* A row is either a CRM master list (opened here) or a link to a screen that
   another module owns. Both read the same on the card. */
interface Row { key: string; label: string; to: string; kind?: string }

function rowsOf(group: MasterGroup): Row[] {
  // Linked screens first: on the ERP card, Item Categories follows the four
  // ERP lists rather than leading them.
  const rows: Row[] = [
    ...(group.links ?? []).map((link) => ({ key: link.to, label: link.label, to: link.to })),
    ...group.kinds.flatMap((kind) => {
      const list = byKind.get(kind)
      return list ? [{ key: kind, label: shortLabel(list), to: `/masters/${kind}`, kind }] : []
    }),
  ]
  const order = group.rowOrder
  if (!order) return rows
  const at = (r: Row) => { const i = order.indexOf(r.key); return i < 0 ? order.length : i }
  return [...rows].sort((a, b) => at(a) - at(b))
}

const ON_MENU = MASTER_GROUPS.filter((g) => !g.path)

export default function Masters() {
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()

  const groups = ON_MENU
    .map((group) => {
      const rows = rowsOf(group)
      const hit = !needle || group.title.toLowerCase().includes(needle)
      return { group, total: rows.length, rows: hit ? rows : rows.filter((r) => r.label.toLowerCase().includes(needle)) }
    })
    .filter(({ rows }) => rows.length > 0)

  return (
    <div className="crm mh">
      {/* No heading: the page's name is in the top bar. Just the search. */}
      <header className="mst-bar">
        <label className="mst-search">
          <IconSearch size={16} />
          <input
            type="search"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Search master lists — country, lead source, vendor…"
            aria-label="Find a master list"
          />
          {q && <button type="button" className="mst-search-x" onClick={() => setQ('')} aria-label="Clear search">×</button>}
        </label>
      </header>

      {groups.length === 0 ? (
        <div className="card mh-empty">
          <span>No master list matches “{q.trim()}”.</span>
          <button className="link-btn" onClick={() => setQ('')}>Clear search</button>
        </div>
      ) : (
        <div className="mh-grid">
          {groups.map(({ group, rows, total }) => (
            <section key={group.key} className="mh-card mst-card">
              <header className="mh-card-head">
                <span className="mh-card-icon" aria-hidden>{GROUP_ICON[group.key] ?? <IconFolder size={18} />}</span>
                <div className="mh-card-text">
                  <h2 className="mh-card-title">
                    {group.title}
                    <span className="mh-card-badge">{total} {total === 1 ? 'list' : 'lists'}</span>
                  </h2>
                </div>
              </header>
              <ul className="mh-rows">
                {rows.map((row) => (
                  <li key={row.key}>
                    <Link to={row.to} className="mh-row">
                      <span className="mst-row-dot" aria-hidden />
                      <span className="mh-row-label">{row.label}</span>
                      {row.kind && <MasterCount kind={row.kind} />}
                      {!row.kind && LINK_COUNTS[row.to] && <LinkCount to={row.to} />}
                      <IconChevronRight size={15} />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

/** How many entries a list holds, so an empty one is visible from the card. */
function MasterCount({ kind }: { kind: string }) {
  const rows = useQuery(`crm-master-count-${kind}`, () => crm.masters(kind))
  if (!rows.data) return <span className="mh-row-count" />
  const n = rows.data.length
  return <span className={`mh-row-count${n === 0 ? ' is-empty' : ''}`}>{n === 0 ? 'Empty' : n}</span>
}

/** How to count the entries behind a linked screen; screens that act rather than list have no count. */
const lookup = (kind: string) => () => erp.lookups(kind).then((r) => r.length)
const LINK_COUNTS: Record<string, () => Promise<number>> = {
  '/masters/erp/stations': () => erp.stations().then((r) => r.length),
  '/masters/erp/vendors': () => erp.vendors().then((r) => r.length),
  '/masters/erp/customers': () => erp.customers().then((r) => r.length),
  '/masters/erp/items': () => erp.items().then((r) => r.length),
  '/masters/erp/companies': () => crm.masters('item-companies').then((r) => r.length),
  '/masters/erp/subcategories': lookup('subcategory'),
  '/masters/erp/units': lookup('unit'),
  '/masters/erp/hsn': lookup('hsn'),
  '/masters/erp/racks': lookup('rack'),
  '/masters/erp/warehouses': () => erp.warehouses().then((r) => r.length),
  '/masters/erp/billseries': () => erp.billSeries().then((r) => r.series.length),
  '/masters/erp/ledgers': () => erp.ledgers().then((r) => r.length),
  '/masters/erp/accounts': () => erp.accountTree().then((r) => r.ledgers.length),
  '/masters/erp/salesmen': () => erp.salesmen().then((r) => r.length),
  '/masters/erp/walkins': () => erp.walkins().then((r) => r.length),
  '/departments': () => api.get<unknown[]>('/org/departments').then((r) => r.length),
  '/designations': () => api.get<unknown[]>('/org/designations').then((r) => r.length),
  '/branches': () => api.get<unknown[]>('/org/branches').then((r) => r.length),
  '/locations': () => api.get<unknown[]>('/attendance/locations').then((r) => r.length),
  '/holidays': () => api.get<unknown[]>('/leave/holidays?include_inactive=true').then((r) => r.length),
}

function LinkCount({ to }: { to: string }) {
  const rows = useQuery(`master-link-count-${to}`, LINK_COUNTS[to])
  if (rows.data === undefined) return <span className="mh-row-count" />
  return <span className={`mh-row-count${rows.data === 0 ? ' is-empty' : ''}`}>{rows.data === 0 ? 'Empty' : rows.data}</span>
}

/** One master list, with its card's other lists as tiles above it. */
export function MasterListPage() {
  const { kind = '' } = useParams()
  if (kind === 'item-companies') return <Navigate to="/masters/erp/companies" replace />
  const group = MASTER_GROUPS.find((entry) => entry.kinds.includes(kind))
  if (!group || !byKind.has(kind)) return <Navigate to="/masters" replace />
  // Sales and Product have their own pages; old links land there.
  if (group.path) return <Navigate to={`${group.path}/${kind}`} replace />
  return <MasterHub key={group.key} groupKey={group.key} />
}
