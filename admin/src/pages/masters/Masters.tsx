/* Master — every reference list in the workspace, on one screen of cards.
 *
 * Masters used to be tabs inside CRM Settings, which made "where do I add a
 * district" a question about which module owns geography. Here a card is a
 * family of lists (Geography, Lead, Service…) and each row opens that list's
 * table at /masters/<kind>. Lists that already have their own screens
 * (departments, ERP items and vendors) are linked from a card rather than
 * rebuilt, so there is still one place each is edited.
 *
 * Sales Master and Product Master are not on this screen: they are worked in
 * daily rather than set once, so each has its own page (MasterHub.tsx).
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
import { LISTS, MASTER_GROUPS, shortLabel, type MasterGroup } from './masterKit'
import MasterHub from './MasterHub'

const byKind = new Map(LISTS.map((list) => [list.kind, list]))

const GROUP_ICON: Record<string, ReactNode> = {
  geography: <IconGlobe size={18} />,
  lead: <IconUsers size={18} />,
  service: <IconLifebuoy size={18} />,
  organisation: <IconBuilding size={18} />,
  erp: <IconFolder size={18} />,
}

/* A row is either a CRM master list (opened here) or a link to a screen that
   another module owns. Both read the same on the card. */
interface Row { key: string; label: string; to: string; kind?: string }

function rowsOf(group: MasterGroup): Row[] {
  return [
    ...group.kinds.flatMap((kind) => {
      const list = byKind.get(kind)
      return list ? [{ key: kind, label: shortLabel(list), to: `/masters/${kind}`, kind }] : []
    }),
    ...(group.links ?? []).map((link) => ({ key: link.to, label: link.label, to: link.to })),
  ]
}

const ON_MENU = MASTER_GROUPS.filter((g) => !g.path)
const OWN_PAGE = MASTER_GROUPS.filter((g) => g.path)

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

  const totalLists = ON_MENU.reduce((n, g) => n + rowsOf(g).length, 0)

  return (
    <div className="crm mh">
      <header className="mh-head">
        <div className="mh-head-text">
          <span className="mh-eyebrow">Configuration</span>
          <h1 className="mh-title">Master</h1>
          <p className="mh-sub">
            Every reference list your team picks from, grouped by what it describes —
            {' '}{totalLists} lists in {ON_MENU.length} groups.
          </p>
        </div>
        <div className="crm-search mh-search">
          <IconSearch size={15} />
          <input
            type="search"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Find a master list…"
            aria-label="Find a master list"
          />
        </div>
      </header>

      {OWN_PAGE.length > 0 && (
        <div className="mh-shortcuts">
          <span className="mh-shortcuts-label">On their own pages</span>
          {OWN_PAGE.map((g) => (
            <Link key={g.key} to={g.path!} className="mh-chip">
              {g.title}
              <IconChevronRight size={13} />
            </Link>
          ))}
        </div>
      )}

      {groups.length === 0 ? (
        <div className="card mh-empty">
          <span>No master list matches “{q.trim()}”.</span>
          <button className="link-btn" onClick={() => setQ('')}>Clear search</button>
        </div>
      ) : (
        <div className="mh-grid">
          {groups.map(({ group, rows, total }) => (
            <section key={group.key} className="mh-card">
              <header className="mh-card-head">
                <span className="mh-card-icon" aria-hidden>{GROUP_ICON[group.key] ?? <IconFolder size={18} />}</span>
                <div className="mh-card-text">
                  <h2 className="mh-card-title">
                    {group.title}
                    <span className="mh-card-badge">{total} {total === 1 ? 'list' : 'lists'}</span>
                  </h2>
                  <p className="mh-card-desc">{group.description}</p>
                </div>
              </header>
              <ul className="mh-rows">
                {rows.map((row) => (
                  <li key={row.key}>
                    <Link to={row.to} className="mh-row">
                      <span className="mh-row-label">{row.label}</span>
                      {row.kind
                        ? <MasterCount kind={row.kind} />
                        : <span className="mh-row-meta">Own screen</span>}
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

/** One master list, with its card's other lists as tiles above it. */
export function MasterListPage() {
  const { kind = '' } = useParams()
  const group = MASTER_GROUPS.find((entry) => entry.kinds.includes(kind))
  if (!group || !byKind.has(kind)) return <Navigate to="/masters" replace />
  // Sales and Product have their own pages; old links land there.
  if (group.path) return <Navigate to={`${group.path}/${kind}`} replace />
  return <MasterHub key={group.key} groupKey={group.key} />
}
