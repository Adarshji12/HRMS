import { visibleItems, type NavAccess, type NavItem } from './nav'

/**
 * The home screen's pinned tiles.
 *
 * Two rules shape this whole file.
 *
 * **A favourite is a nav entry, never a string somebody typed.** The catalogue
 * is `visibleItems(access)` — the same list the rail, the breadcrumb and the
 * command palette are built from (D: nav.tsx is the single source of truth).
 * So a page that gets renamed renames its tile, a page that gets deleted loses
 * its tile, and a tile can never point somewhere the signed-in person is not
 * allowed to go.
 *
 * **Only the paths are stored.** Labels and icons are looked up on every read.
 * Storing the label as well would freeze it at the moment somebody pinned it,
 * and the first rename would leave a tile whose caption disagrees with the page
 * it opens.
 *
 * Storage is this browser's `localStorage`, so the choice does not follow
 * anyone to a second machine. That is a deliberate limit rather than an
 * oversight: pinning is a convenience, and putting it on the server costs a
 * column, a migration and an endpoint for something a person re-picks in four
 * clicks. If it should follow them, that is the change to make — not a sync
 * layer on top of this.
 */

const KEY = 'hrdesktimesol.favourites'

/** Eight is two full rows at the widest tile size, and the point where a grid
 *  of shortcuts stops being faster to scan than the rail it shortcuts. */
export const MAX_FAVOURITES = 8

/**
 * What somebody sees before they have chosen anything.
 *
 * Self-service first, in the order an ordinary week touches them, and filtered
 * against access like everything else here — an employee holds none of the
 * administration pages, so a fixed list would open their first morning with
 * three tiles missing. Five, not eight: leaving room in the grid is what makes
 * the empty "+" tile read as an invitation rather than as a gap.
 */
const DEFAULTS = ['/attendance', '/leave', '/timesheets', '/payslips', '/helpdesk']

export interface Favourite {
  to: string
  label: string
  icon: NavItem['icon']
  /** The module it came from — the disambiguator in the picker, where
   *  "Approvals" appears under both Expenses and the top-level inbox. */
  heading?: string
}

/** Every page this person could pin, in rail order. */
export function catalogue(access: NavAccess): Favourite[] {
  const seen = new Set<string>()
  const out: Favourite[] = []
  for (const item of visibleItems(access)) {
    /* `/` is the console root and reads as "Company" in the dashboard module.
       As a tile captioned "Company" pointing at the page you are one click
       from anyway, it is the one entry worth leaving out. */
    if (item.to === '/' || seen.has(item.to)) continue
    seen.add(item.to)
    out.push({ to: item.to, label: item.label, icon: item.icon, heading: item.heading })
  }
  return out
}

function stored(): string[] | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : null
  } catch {
    /* A private window, a cleared profile, or a value some other version of
       this code wrote. None of them is an error worth showing anybody — the
       defaults are a working home screen. */
    return null
  }
}

/**
 * The tiles to draw, resolved against what this person can actually open.
 *
 * `null` from storage means "never chosen", which is not the same as "chosen
 * nothing": the first shows the defaults, the second shows an empty grid, and
 * conflating them would make an emptied grid refill itself on the next visit.
 */
export function readFavourites(access: NavAccess): Favourite[] {
  const byPath = new Map(catalogue(access).map((entry) => [entry.to, entry]))
  const paths = stored() ?? DEFAULTS
  return paths
    .map((to) => byPath.get(to))
    .filter((entry): entry is Favourite => entry !== undefined)
    .slice(0, MAX_FAVOURITES)
}

export function writeFavourites(paths: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(paths.slice(0, MAX_FAVOURITES)))
  } catch {
    /* Storage full or blocked. The tiles the caller already put on screen stay
       there for this session; they simply will not survive a reload. */
  }
}
