import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import '../../../styles/welcome.css'
import { api } from '../../../lib/api'
import { useAuth } from '../../../lib/auth'
import { useQuery } from '../../../lib/useQuery'
/* `relativeTime`, not `shortDate`: `published_at` is a timestamp and shortDate
   parses date-only strings — handing it one would silently render an invalid
   date. "3 days ago" is also the more useful reading of an announcement. */
import { relativeTime } from '../../../lib/format'
import type { NavAccess } from '../../../lib/nav'
import {
  MAX_FAVOURITES,
  catalogue,
  readFavourites,
  writeFavourites,
  type Favourite,
} from '../../../lib/favourites'
import { EmptyState, ErrorNote, Loading } from '../../../components/ui'
import {
  IconBell,
  IconCheck,
  IconClose,
  IconChevronRight,
  IconLifebuoy,
  IconPlus,
  IconStar,
} from '../../../components/Icons'

/**
 * The welcome screen — the half of `/home` that greets rather than reports.
 *
 * Home used to open on six data cards. They are the right thing for somebody
 * mid-week who wants to know where their hours stand, and the wrong thing for
 * the other visit: somebody arriving to *do* one thing, who has to read six
 * summaries to find the link to it. So `/home` is now two panels — this one and
 * the dashboard — and this one is first, because it answers "what am I here
 * for" in a click rather than a read.
 *
 * Three things are on it and each is doing a job:
 *
 * - **The greeting** dates the session and names the person, so a shared or
 *   left-open browser identifies itself before anybody acts on what it shows.
 * - **Favourites** are the click. They are nav entries, pinned per browser —
 *   see `lib/favourites.ts` for why they are paths rather than labels.
 * - **The noticeboard card** is the only thing here that fetches, and it fails
 *   alone: an announcements outage costs the card, never the shortcuts beside
 *   it. That is the same rule the dashboard panel is built on.
 *
 * Nothing here re-derives a permission. Every tile, chip and link comes from
 * `nav.tsx` filtered by the caller's own access, so this page cannot offer a
 * door the rail would not.
 */

/* ---------------------------------------------------------------- types --- */

/** `engagement.py` — `AnnouncementOut`, only the fields this card reads. */
interface Announcement {
  id: string
  title: string
  body: string
  is_pinned: boolean
  requires_acknowledgement: boolean
  published_at?: string | null
  published_by_name?: string | null
  read_at?: string | null
  acknowledged_at?: string | null
}

/* -------------------------------------------------------------- helpers --- */

export function greeting(at: Date = new Date()): string {
  const hour = at.getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

/**
 * The "where do I find…" row.
 *
 * Paths, not labels: each one is resolved against the catalogue below, which is
 * this person's own nav. An entry they cannot open simply is not drawn, so this
 * list is safe to state flatly here rather than gating every line by hand. The
 * captions are the questions people ask, which is the one place this page is
 * allowed to disagree with the rail's own wording — "Holiday calendar" is what
 * somebody looks for; "My leave" is where it lives.
 */
const HELP_LINKS: Array<{ to: string; label: string }> = [
  { to: '/leave', label: 'Holiday calendar' },
  { to: '/directory', label: 'Company directory' },
  { to: '/hierarchy', label: 'Who reports to whom' },
  { to: '/noticeboard', label: 'Announcements' },
  { to: '/helpdesk', label: 'Raise a ticket' },
  { to: '/my-letters', label: 'My letters' },
  { to: '/payslips', label: 'My payslips' },
  { to: '/my-assets', label: 'Assets issued to me' },
]

/* ============================================================== the page === */

export default function Welcome({ access }: { access: NavAccess }) {
  const { user, organization } = useAuth()

  /* The catalogue is what this person may open; both the favourites grid and
     the help row are filtered through it, so neither can offer a closed door.
     Memoised rather than recomputed per render — it walks every nav entry in
     the product. */
  const all = useMemo(() => catalogue(access), [access])
  const known = useMemo(() => new Map(all.map((entry) => [entry.to, entry])), [all])
  const help = HELP_LINKS.filter((link) => known.has(link.to))

  const first = user?.full_name?.split(/\s+/)[0]
  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  return (
    <div className="wel">
      <section className="wel-hero">
        <div className="wel-hero-text">
          <h1 className="wel-greeting">
            {greeting()}
            {first ? <>, <span className="wel-name">{first}</span></> : ''}
          </h1>
          <p className="wel-sub">Everything you reach for, one click away.</p>
          <p className="wel-date">
            {today}
            {organization?.timezone ? ` · ${organization.timezone}` : ''}
          </p>
        </div>
        <Skyline />
      </section>

      <div className="wel-body">
        <div className="wel-main">
          <Favourites access={access} catalogue={all} />

          {help.length > 0 && (
            <section className="card wel-card">
              <div className="card-head">
                <h2 className="card-title">
                  <IconLifebuoy size={15} /> Help links
                </h2>
              </div>
              <div className="wel-chips">
                {help.map((link) => (
                  <Link key={link.to} to={link.to} className="wel-chip">
                    {link.label}
                    <IconChevronRight size={13} />
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="wel-aside">
          <Noticeboard />
        </aside>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------- favourites ---- */

function Favourites({ access, catalogue: all }: { access: NavAccess; catalogue: Favourite[] }) {
  /* Read once, then owned here. Re-reading storage on every render would make
     the grid flicker back to the saved order between a click and its write. */
  const [pinned, setPinned] = useState<Favourite[]>(() => readFavourites(access))
  const [picking, setPicking] = useState(false)
  const [query, setQuery] = useState('')

  const chosen = new Set(pinned.map((entry) => entry.to))
  const full = pinned.length >= MAX_FAVOURITES

  function commit(next: Favourite[]) {
    setPinned(next)
    writeFavourites(next.map((entry) => entry.to))
  }

  function toggle(entry: Favourite) {
    if (chosen.has(entry.to)) commit(pinned.filter((item) => item.to !== entry.to))
    else if (!full) commit([...pinned, entry])
  }

  const needle = query.trim().toLowerCase()
  const matches = needle
    ? all.filter(
        (entry) =>
          entry.label.toLowerCase().includes(needle) ||
          (entry.heading ?? '').toLowerCase().includes(needle),
      )
    : all

  return (
    <section className="card wel-card">
      <div className="card-head">
        <h2 className="card-title">
          <IconStar size={15} /> My favourites
        </h2>
        <button className="link-btn" onClick={() => setPicking((v) => !v)} aria-expanded={picking}>
          {picking ? 'Done' : 'Edit'}
        </button>
      </div>

      {pinned.length === 0 && !picking ? (
        <EmptyState
          icon={<IconStar size={20} />}
          title="Nothing pinned"
          body="Pin the pages you open most and they will be waiting here every morning."
        />
      ) : (
        <div className="fav-grid">
          {pinned.map((entry) => (
            <div className="fav-cell" key={entry.to}>
              <Link to={entry.to} className="fav-tile">
                <span className="fav-glyph"><entry.icon size={19} /></span>
                <span className="fav-label">{entry.label}</span>
              </Link>
              {/* Only while editing. A remove control on every tile all of the
                  time is a mis-click waiting to happen on the one grid people
                  use without looking. */}
              {picking && (
                <button
                  className="fav-remove"
                  onClick={() => toggle(entry)}
                  aria-label={`Remove ${entry.label} from favourites`}
                >
                  <IconClose size={13} />
                </button>
              )}
            </div>
          ))}

          {!full && (
            <button
              className="fav-tile fav-add"
              onClick={() => setPicking(true)}
              aria-label="Add a favourite"
            >
              <span className="fav-glyph fav-glyph-add"><IconPlus size={19} /></span>
              <span className="fav-label">Add</span>
            </button>
          )}
        </div>
      )}

      {picking && (
        <div className="fav-picker">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search pages…"
            aria-label="Search pages to pin"
          />
          <p className="fav-picker-note">
            {full
              ? `${MAX_FAVOURITES} pinned — the most this grid holds. Remove one to add another.`
              : `${pinned.length} of ${MAX_FAVOURITES} pinned.`}
          </p>
          <div className="fav-options">
            {matches.map((entry) => {
              const on = chosen.has(entry.to)
              return (
                <button
                  key={entry.to}
                  className={`fav-option${on ? ' fav-option-on' : ''}`}
                  onClick={() => toggle(entry)}
                  aria-pressed={on}
                  /* Not a disabled button: a full grid is a state to explain,
                     and a dead control explains nothing. It stays pressable and
                     does nothing, with the note above saying why. */
                  aria-disabled={!on && full}
                >
                  <span className="fav-option-glyph"><entry.icon size={15} /></span>
                  <span className="fav-option-text">
                    <span className="fav-option-label">{entry.label}</span>
                    {entry.heading && <span className="fav-option-module">{entry.heading}</span>}
                  </span>
                  {on && <IconCheck size={14} />}
                </button>
              )
            })}
            {matches.length === 0 && (
              <p className="fav-picker-note">Nothing matches that.</p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

/* ---------------------------------------------------------- noticeboard --- */

/**
 * The newest thing the company said.
 *
 * One request, and it owns its own failure — the shortcuts beside it must keep
 * working when engagement is down. Pinned first and then newest, which is the
 * order the noticeboard itself uses; a card that disagreed with the page it
 * links to would be showing a "latest" that is not the top of the list.
 */
function Noticeboard() {
  const q = useQuery<Announcement[]>('welcome-announcements', () =>
    api.get<Announcement[]>('/engagement/announcements'),
  )

  const posts = useMemo(() => {
    const rows = q.data ?? []
    return [...rows].sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1
      return (b.published_at ?? '').localeCompare(a.published_at ?? '')
    })
  }, [q.data])

  const unread = posts.filter((post) => !post.read_at).length

  return (
    <section className="card wel-card wel-notice">
      <div className="card-head">
        <h2 className="card-title">
          <IconBell size={15} /> Noticeboard
        </h2>
        {/* Counted from the rows on screen, never read out of a count field —
            D-026. */}
        {unread > 0 && <span className="wel-badge">{unread} unread</span>}
      </div>

      {q.loading ? (
        <Loading label="Reading the noticeboard…" />
      ) : q.error ? (
        <ErrorNote>{q.error}</ErrorNote>
      ) : posts.length === 0 ? (
        <EmptyState
          icon={<IconBell size={20} />}
          title="Nothing posted"
          body="Company announcements land here. You will see them the moment they go out."
        />
      ) : (
        <>
          {posts.slice(0, 2).map((post) => (
            <article className={`wel-post${post.read_at ? ' wel-post-read' : ''}`} key={post.id}>
              <h3 className="wel-post-title">
                {post.is_pinned && <span className="wel-pin">Pinned</span>}
                {post.title}
              </h3>
              <p className="wel-post-body">{post.body}</p>
              <p className="wel-post-meta">
                {post.published_by_name ?? 'Your company'}
                {post.published_at ? ` · ${relativeTime(post.published_at)}` : ''}
                {post.requires_acknowledgement && !post.acknowledged_at && (
                  <b> · needs your acknowledgement</b>
                )}
              </p>
            </article>
          ))}
          <div className="wel-notice-foot">
            <Link to="/noticeboard">
              {posts.length > 2 ? `All ${posts.length} announcements` : 'Open the noticeboard'} →
            </Link>
          </div>
        </>
      )}
    </section>
  )
}

/* -------------------------------------------------------------- skyline --- */

/**
 * The hero illustration.
 *
 * Decorative and `aria-hidden` — it says nothing a screen reader needs, and a
 * described city skyline would only be noise in front of the greeting. Drawn
 * inline rather than shipped as an asset for the same reason the brand mark is:
 * it has to paint in the first frame. Its gradient stops are theme tokens, so
 * it follows the console into dark mode instead of glowing on it.
 *
 * It carries the only free colour on this page, and that is allowed precisely
 * because it encodes nothing: a sunrise behind a skyline is not a status and
 * not a data mark, so the rule keeping chrome out of the data palette has
 * nothing to say about it.
 */
/** Ground line of the 560×170 box every tower is measured up from. */
const GROUND = 170

interface Tower {
  x: number
  w: number
  h: number
  /** A flat roof, a setback storey, or a mast. Three shapes is what separates a
   *  skyline from a bar chart — evenly capped rectangles read as a chart, and a
   *  chart is the one thing this illustration must not be mistaken for in a
   *  product full of real ones. */
  roof?: 'step' | 'spire'
}

const TOWERS: Tower[] = [
  { x: 0, w: 46, h: 62 },
  { x: 40, w: 30, h: 96, roof: 'step' },
  { x: 74, w: 38, h: 48 },
  { x: 108, w: 26, h: 128, roof: 'spire' },
  { x: 130, w: 44, h: 78 },
  { x: 170, w: 32, h: 108, roof: 'step' },
  { x: 198, w: 40, h: 66 },
  { x: 234, w: 28, h: 142, roof: 'spire' },
  { x: 258, w: 46, h: 90 },
  { x: 300, w: 30, h: 58 },
  { x: 326, w: 36, h: 116, roof: 'step' },
  { x: 358, w: 42, h: 74 },
  { x: 396, w: 28, h: 132, roof: 'spire' },
  { x: 420, w: 44, h: 60 },
  { x: 460, w: 32, h: 98, roof: 'step' },
  { x: 488, w: 40, h: 72 },
  { x: 524, w: 36, h: 52 },
]

/** Lit windows for one tower — a column every 13px, a row every 15px. */
function windows(tower: Tower): Array<{ x: number; y: number }> {
  const cells: Array<{ x: number; y: number }> = []
  const top = GROUND - tower.h
  for (let x = tower.x + 8; x < tower.x + tower.w - 8; x += 13) {
    for (let y = top + 14; y < GROUND - 8; y += 15) {
      /* Not every pane is lit. A full grid reads as graph paper; the gaps are
         what make it a building somebody is working late in. */
      if ((x + y) % 7 < 3) continue
      cells.push({ x, y })
    }
  }
  return cells
}

function Skyline() {
  return (
    <svg
      className="wel-skyline"
      viewBox="0 0 560 170"
      preserveAspectRatio="xMaxYMax meet"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="wel-sky" x1="0" y1="1" x2="0.3" y2="0">
          <stop offset="0" stopColor="var(--brand)" stopOpacity="0.95" />
          <stop offset="1" stopColor="var(--brand-accent)" stopOpacity="0.6" />
        </linearGradient>
        <linearGradient id="wel-sun" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="var(--brand-accent)" stopOpacity="0.45" />
          <stop offset="1" stopColor="var(--status-warn)" stopOpacity="0.8" />
        </linearGradient>
      </defs>

      {/* Behind everything, and high enough to clear the tallest roof — a sun
          that only shows between two towers reads as a stray circle. */}
      <circle cx="452" cy="46" r="40" fill="url(#wel-sun)" />

      {/* The far rank. Set back by opacity and by height alone; a second tint
          would be a second palette for one decoration. */}
      <g fill="var(--brand-accent)" opacity="0.18">
        {TOWERS.map((tower) => (
          <rect
            key={`far-${tower.x}`}
            x={tower.x + 16}
            y={GROUND - tower.h * 0.66}
            width={tower.w}
            height={tower.h}
            rx="3"
          />
        ))}
      </g>

      <g fill="url(#wel-sky)">
        {TOWERS.map((tower) => (
          <g key={`near-${tower.x}`}>
            <rect x={tower.x} y={GROUND - tower.h} width={tower.w} height={tower.h} rx="3" />
            {tower.roof === 'step' && (
              <rect
                x={tower.x + tower.w * 0.22}
                y={GROUND - tower.h - 12}
                width={tower.w * 0.56}
                height={14}
                rx="2"
              />
            )}
            {tower.roof === 'spire' && (
              <rect
                x={tower.x + tower.w / 2 - 1.5}
                y={GROUND - tower.h - 20}
                width="3"
                height="22"
                rx="1.5"
              />
            )}
          </g>
        ))}
      </g>

      {/* Windows in the page's own surface colour, so they read as light in a
          light theme and as unlit panes in a dark one without a second token. */}
      <g fill="var(--surface-1)" opacity="0.5">
        {TOWERS.flatMap((tower) =>
          windows(tower).map((cell) => (
            <rect key={`w-${cell.x}-${cell.y}`} x={cell.x} y={cell.y} width="4" height="6" rx="1" />
          )),
        )}
      </g>
    </svg>
  )
}
