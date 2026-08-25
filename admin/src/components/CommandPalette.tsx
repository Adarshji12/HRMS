import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useQuery } from '../lib/useQuery'
import { visibleItems, type NavAccess } from '../lib/nav'
import type { Project, User } from '../lib/types'
import { Avatar } from './ui'
import { IconChart, IconFolder, IconReturn, IconSearch } from './Icons'

interface CatalogueEntry {
  key: string
  title: string
  group: string
}

type Scope = 'all' | 'pages' | 'people' | 'projects' | 'reports'

const SCOPES: Array<{ id: Scope; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'pages', label: 'Pages' },
  { id: 'people', label: 'People' },
  { id: 'projects', label: 'Projects' },
  { id: 'reports', label: 'Reports' },
]

interface Hit {
  id: string
  kind: Exclude<Scope, 'all'>
  label: string
  meta?: string
  to: string
  /** Avatar for people, glyph for everything else. */
  avatar?: string
  icon?: (p: { size?: number }) => JSX.Element
}

const KIND_LABEL: Record<Hit['kind'], string> = {
  pages: 'Pages',
  people: 'People',
  projects: 'Projects',
  reports: 'Reports',
}

/** Case-insensitive substring, plus a crude rank so exact prefixes float up. */
function score(haystack: string, needle: string): number {
  const hay = haystack.toLowerCase()
  const index = hay.indexOf(needle)
  if (index < 0) return -1
  return index === 0 ? 0 : 1
}

export default function CommandPalette({
  open,
  onClose,
  access,
}: {
  open: boolean
  onClose: () => void
  access: NavAccess
}) {
  const navigate = useNavigate()
  const [term, setTerm] = useState('')
  const [scope, setScope] = useState<Scope>('all')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  /* Fetched only once the palette has been opened, and then kept — a console
     that hits three endpoints on every page load to populate a search nobody
     opened is paying for a feature that is not on screen.

     Errors are deliberately unread: /admin/employees and the report catalogue
     are role-scoped, and for a role that cannot reach them the right result is
     a section with nothing in it, not an error the user cannot act on. */
  const people = useQuery<User[]>('palette:employees', () => api.get<User[]>('/admin/employees'), {
    enabled: open,
  })
  const projects = useQuery<Project[]>('palette:projects', () => api.get<Project[]>('/projects'), {
    enabled: open,
  })
  const reports = useQuery<CatalogueEntry[]>(
    'palette:reports',
    () => api.get<CatalogueEntry[]>('/reports/catalogue'),
    { enabled: open },
  )

  const loading = open && (people.loading || projects.loading || reports.loading)

  const hits = useMemo<Hit[]>(() => {
    const needle = term.trim().toLowerCase()
    const pool: Hit[] = []

    for (const item of visibleItems(access)) {
      pool.push({
        id: `page:${item.to}`,
        kind: 'pages',
        label: item.label,
        meta: item.heading,
        to: item.to,
        icon: item.icon,
      })
    }
    for (const person of people.data ?? []) {
      pool.push({
        id: `person:${person.id}`,
        kind: 'people',
        label: person.full_name,
        meta: person.email,
        to: `/employees/${person.id}`,
        avatar: person.full_name,
      })
    }
    for (const project of projects.data ?? []) {
      pool.push({
        id: `project:${project.id}`,
        kind: 'projects',
        label: project.name,
        meta: project.code ?? undefined,
        to: `/projects/${project.id}`,
        icon: IconFolder,
      })
    }
    for (const report of reports.data ?? []) {
      pool.push({
        id: `report:${report.key}`,
        kind: 'reports',
        label: report.title,
        meta: report.group,
        to: `/reports?r=${report.key}`,
        icon: IconChart,
      })
    }

    const scoped = scope === 'all' ? pool : pool.filter((hit) => hit.kind === scope)
    if (!needle) {
      // Nothing typed yet: show where you can go, not 200 rows of everything.
      return scope === 'all' ? scoped.filter((hit) => hit.kind === 'pages') : scoped.slice(0, 40)
    }
    return scoped
      .map((hit) => ({
        hit,
        rank: Math.max(
          score(hit.label, needle),
          hit.meta ? (score(hit.meta, needle) < 0 ? -1 : 2) : -1,
        ),
      }))
      .filter((entry) => entry.rank >= 0)
      .sort((a, b) => a.rank - b.rank || a.hit.label.localeCompare(b.hit.label))
      .slice(0, 40)
      .map((entry) => entry.hit)
  }, [term, scope, access, people.data, projects.data, reports.data])

  // A cursor left pointing at row 12 of a list that now has three rows selects
  // nothing, so Enter would appear to do nothing at all.
  useEffect(() => setCursor(0), [term, scope])

  useEffect(() => {
    if (!open) return
    setTerm('')
    setScope('all')
    setCursor(0)
    // The dialog mounts before the browser can focus it; one frame is enough.
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  // Keeping the cursor on screen matters more than it looks: arrowing past the
  // fold with no scroll makes the list appear to stop responding.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-cursor="1"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [cursor, hits.length])

  if (!open) return null

  function choose(hit: Hit | undefined) {
    if (!hit) return
    onClose()
    navigate(hit.to)
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setCursor((c) => (hits.length ? (c + 1) % hits.length : 0))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setCursor((c) => (hits.length ? (c - 1 + hits.length) % hits.length : 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(hits[cursor])
    } else if (event.key === 'Tab') {
      // Tab cycles the scope filter. There is nothing else in the dialog worth
      // tabbing to, and it saves reaching for the mouse mid-search.
      event.preventDefault()
      const step = event.shiftKey ? -1 : 1
      const next = (SCOPES.findIndex((s) => s.id === scope) + step + SCOPES.length) % SCOPES.length
      setScope(SCOPES[next].id)
    }
  }

  let lastKind: Hit['kind'] | null = null

  return (
    <div className="palette-layer" onKeyDown={onKeyDown}>
      <div className="palette-scrim" onClick={onClose} aria-hidden="true" />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search">
        <div className="palette-input">
          <IconSearch size={18} />
          <input
            ref={inputRef}
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Search people, projects, reports and pages…"
            aria-label="Search"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="kbd">Esc</kbd>
        </div>

        <div className="palette-scopes" role="tablist" aria-label="Filter results">
          {SCOPES.map((entry) => (
            <button
              key={entry.id}
              role="tab"
              aria-selected={scope === entry.id}
              className={`scope-chip${scope === entry.id ? ' scope-on' : ''}`}
              onClick={() => setScope(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="palette-results" ref={listRef}>
          {hits.length === 0 && (
            <p className="palette-empty">
              {loading ? 'Loading…' : `Nothing matches “${term.trim()}”.`}
            </p>
          )}
          {hits.map((hit, index) => {
            const heading = hit.kind !== lastKind ? KIND_LABEL[hit.kind] : null
            lastKind = hit.kind
            const Glyph = hit.icon
            return (
              <div key={hit.id}>
                {heading && <div className="palette-group">{heading}</div>}
                <button
                  className={`palette-hit${index === cursor ? ' palette-on' : ''}`}
                  data-cursor={index === cursor ? '1' : undefined}
                  onMouseMove={() => setCursor(index)}
                  onClick={() => choose(hit)}
                >
                  {hit.avatar ? (
                    <Avatar name={hit.avatar} small />
                  ) : (
                    <span className="palette-glyph">{Glyph ? <Glyph size={16} /> : null}</span>
                  )}
                  <span className="palette-label">{hit.label}</span>
                  {hit.meta && <span className="palette-meta">{hit.meta}</span>}
                  <IconReturn size={15} />
                </button>
              </div>
            )
          })}
        </div>

        <div className="palette-foot">
          <span><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> move</span>
          <span><kbd className="kbd">↵</kbd> open</span>
          <span><kbd className="kbd">Tab</kbd> filter</span>
        </div>
      </div>
    </div>
  )
}
