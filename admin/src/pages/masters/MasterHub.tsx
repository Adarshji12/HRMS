/* Sales Master and Product Master — a master family on its own page.
 *
 * These two are not set once and forgotten like geography: products get
 * repriced, plans added, stages and territories tuned as the sales team
 * grows. So each has a page of its own, reached from the chips at the top of
 * the Master menu, instead of a card on it.
 *
 * The page is a row of summary tiles, one per list, and the chosen list's
 * table under them. A tile is the tab: it says how many entries the list
 * holds and how many are live, so an empty or half-retired list is visible
 * before it is opened.
 */

import { Link, Navigate, useParams } from 'react-router-dom'
import '../../styles/crm.css'
import '../../styles/masterhub.css'
import { useQuery } from '../../lib/useQuery'
import { crm } from '../crm/api'
import { LISTS, MASTER_GROUPS, MasterTable, shortLabel } from './masterKit'
import { MasterTrail } from './MasterBack'

const byKind = new Map(LISTS.map((list) => [list.kind, list]))

/* One line under each tile's name. The list's own description is a paragraph
   and belongs above the table, not squeezed into a tile. */
const TAGLINES: Record<string, string> = {
  'opportunity-stages': 'Pipeline, probability and forecast',
  'lost-reasons': 'Why deals are lost',
  competitors: 'Who you bid against',
  territories: 'Sales regions by state',
  'contact-designations': 'Customer-side job titles',
  products: 'Rates, GST and categories',
  plans: 'Priced terms and renewals',
  countries: 'Top of the address chain',
  states: 'Decides which GST applies',
  districts: 'Within a state',
  cities: 'Within a district',
  statuses: 'Where a lead stands',
  sources: 'Where a lead came from',
  campaigns: 'Which campaign brought it',
  industries: 'What the customer does',
  dispositions: 'How a support call ended',
  'visit-types': 'Kinds of field visit',
}

/* Also the page behind every list on the Master menu (/masters/<kind>): the
   card's lists become the tiles, and the eyebrow links back to the menu. */
export default function MasterHub({ groupKey }: { groupKey: string }) {
  const group = MASTER_GROUPS.find((g) => g.key === groupKey)!
  const { kind } = useParams()
  const own = Boolean(group.path)
  const base = group.path ?? '/masters'
  const active = kind ?? group.kinds[0]
  if (!group.kinds.includes(active)) return <Navigate to={base} replace />
  const list = byKind.get(active)!

  return (
    <div className="crm mh">
      {/* Just the way back: the page's name is in the top bar, and the
          tiles below say which lists it holds. */}
      <MasterTrail />

      <nav className="mh-tiles" aria-label={`${group.title} lists`}>
        {group.kinds.map((k, i) => {
          const entry = byKind.get(k)
          if (!entry) return null
          const on = k === active
          return (
            <Link
              key={k}
              to={own && i === 0 ? base : `${base}/${k}`}
              className={`mh-tile${on ? ' is-on' : ''}`}
              aria-current={on ? 'page' : undefined}
            >
              <span className="mh-tile-name">{shortLabel(entry)}</span>
              <span className="mh-tile-tag">{TAGLINES[k] ?? entry.description}</span>
              <TileCount kind={k} />
            </Link>
          )
        })}
      </nav>

      <div className="mh-table">
        <MasterTable key={list.kind} list={list} />
      </div>
    </div>
  )
}

/** Entries on the list, and how many of them are still offered in dropdowns. */
function TileCount({ kind }: { kind: string }) {
  const rows = useQuery<Array<{ is_active?: boolean }>>(
    `crm-master-count-${kind}`,
    () => crm.masters(kind),
  )
  if (!rows.data) return <span className="mh-tile-count"><strong>–</strong></span>
  const total = rows.data.length
  const live = rows.data.filter((r) => r.is_active !== false).length
  return (
    <span className="mh-tile-count">
      <strong>{total}</strong>
      <span className={`mh-pill${total === 0 ? ' is-empty' : ''}`}>
        {total === 0 ? 'Empty' : live === total ? 'All active' : `${live} active`}
      </span>
    </span>
  )
}
