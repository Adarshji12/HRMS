import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface TabDef<T extends string> {
  id: T
  label: string
  /** Count or ratio shown as a badge — "12", "3/12". Zero still renders. */
  badge?: string | number
}

/**
 * Tab bar.
 *
 * A recessed track with one raised pill that slides between positions. The
 * slide is the point: an indicator that jumps gives you a new selected tab,
 * one that travels tells you which tab you came from, and that is what stops a
 * four-tab page feeling like four unrelated pages.
 *
 * The thumb is measured rather than derived from a percentage, because these
 * labels have wildly different widths ("Teams" against "Attribution rules") and
 * an even split would leave the pill sitting off its own label.
 *
 * Semantics are the real ones: role=tablist/tab with aria-selected, and the
 * arrow-key behaviour that comes with them. The previous markup marked the
 * active tab with aria-current="page", which announces a link to the current
 * page — these are buttons that swap a panel without navigating anywhere.
 */
export default function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: ReadonlyArray<TabDef<T>>
  value: T
  onChange: (id: T) => void
  label: string
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef(new Map<T, HTMLButtonElement>())
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null)

  const measure = useCallback(() => {
    const list = listRef.current
    const active = tabRefs.current.get(value)
    if (!list || !active) return
    // offsetLeft, not getBoundingClientRect: the track scrolls horizontally on
    // a phone, and a viewport-relative x would slide the pill off its tab the
    // moment the strip is scrolled.
    setThumb({ x: active.offsetLeft, w: active.offsetWidth })
  }, [value])

  useLayoutEffect(measure, [measure, items])

  useEffect(() => {
    const list = listRef.current
    if (!list || typeof ResizeObserver === 'undefined') return
    // Labels reflow when the window changes and when a badge count updates.
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    for (const node of tabRefs.current.values()) observer.observe(node)
    return () => observer.disconnect()
  }, [measure])

  // Keep the selected tab in view when it is reached by keyboard on a strip
  // that has scrolled.
  useEffect(() => {
    tabRefs.current.get(value)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [value])

  function onKeyDown(event: React.KeyboardEvent) {
    const index = items.findIndex((item) => item.id === value)
    let next = -1
    if (event.key === 'ArrowRight') next = (index + 1) % items.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    if (next < 0) return
    event.preventDefault()
    onChange(items[next].id)
    tabRefs.current.get(items[next].id)?.focus()
  }

  return (
    <div className="tabs" role="tablist" aria-label={label} ref={listRef} onKeyDown={onKeyDown}>
      {thumb && (
        <span
          className="tab-thumb"
          aria-hidden="true"
          style={{ transform: `translateX(${thumb.x}px)`, width: thumb.w }}
        />
      )}
      {items.map((item) => {
        const selected = item.id === value
        return (
          <button
            key={item.id}
            ref={(node) => {
              if (node) tabRefs.current.set(item.id, node)
              else tabRefs.current.delete(item.id)
            }}
            type="button"
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={selected}
            aria-controls={`panel-${item.id}`}
            /* Only the selected tab is in the tab order; the arrow keys move
               between them once you are inside. That is the tablist contract —
               otherwise a four-tab bar costs four presses to step over. */
            tabIndex={selected ? 0 : -1}
            className={`tab${selected ? ' tab-active' : ''}`}
            onClick={() => onChange(item.id)}
          >
            {item.label}
            {item.badge !== undefined && item.badge !== '' && (
              <span className="tab-badge">{item.badge}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** The panel half of the pair, so the ids line up with what Tabs advertises. */
export function TabPanel({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={-1}>
      {children}
    </div>
  )
}
