import type { ReactNode } from 'react'

/* Nav icons.
 *
 * Inline SVG rather than an icon font or package: a dozen glyphs is not worth a
 * dependency, and `currentColor` means they inherit the nav's hover and active
 * states for free — no second place to keep colours in sync.
 *
 * All are aria-hidden. Every icon here sits beside a visible text label, so
 * announcing it would only make screen readers say everything twice.
 */
function Svg({
  size = 17,
  className,
  children,
}: {
  size?: number
  /* Only so the nav's disclosure chevron can be rotated by CSS. Icons are
     otherwise styled entirely by `currentColor` from whatever contains them. */
  className?: string
  children: ReactNode
}) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false" className={className}
      style={{ flex: 'none' }}
    >
      {children}
    </svg>
  )
}

type P = { size?: number; className?: string }

export const IconDashboard = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </Svg>
)

// A house, not a fourth panel layout. Home and Dashboard sit in the same nav
// group, and two identical glyphs in one group is a rail you have to read
// rather than scan.
export const IconHome = (p: P) => (
  <Svg {...p}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5.5 9.5V20h13V9.5" />
    <path d="M9.5 20v-6h5v6" />
  </Svg>
)

export const IconClock = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></Svg>
)

export const IconCamera = (p: P) => (
  <Svg {...p}>
    <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.2l1.2-2h8.2l1.2 2h2.2A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
    <circle cx="12" cy="13" r="3.4" />
  </Svg>
)

export const IconGlobe = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" /><path d="M3 12h18" />
    <path d="M12 3c2.4 2.6 3.6 5.6 3.6 9s-1.2 6.4-3.6 9c-2.4-2.6-3.6-5.6-3.6-9s1.2-6.4 3.6-9z" />
  </Svg>
)

export const IconUsers = (p: P) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.4" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
    <path d="M16.5 5.2a3.4 3.4 0 0 1 0 6.6" /><path d="M18 14.4a6.5 6.5 0 0 1 3.5 5.6" />
  </Svg>
)

export const IconSitemap = (p: P) => (
  <Svg {...p}>
    <rect x="9" y="2.5" width="6" height="5" rx="1.3" />
    <rect x="2.5" y="16.5" width="6" height="5" rx="1.3" />
    <rect x="15.5" y="16.5" width="6" height="5" rx="1.3" />
    <path d="M12 7.5v5M5.5 16.5v-2.5h13v2.5" />
  </Svg>
)

export const IconBuilding = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 21h17" />
    <path d="M5.5 21V5.5A1.5 1.5 0 0 1 7 4h6a1.5 1.5 0 0 1 1.5 1.5V21" />
    <path d="M14.5 21V10H18a1.5 1.5 0 0 1 1.5 1.5V21" />
    <path d="M8.5 8h3M8.5 12h3M8.5 16h3" />
  </Svg>
)

export const IconSheet = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
    <path d="M3.5 9h17M9 9v11.5" /><path d="M12.5 13h5M12.5 16.5h5" />
  </Svg>
)

export const IconFolder = (p: P) => (
  <Svg {...p}>
    <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h9A1.5 1.5 0 0 1 21 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
  </Svg>
)

export const IconChart = (p: P) => (
  <Svg {...p}><path d="M4 20V4M4 20h16" /><path d="M8 16v-4M12.5 16V7.5M17 16v-6" /></Svg>
)

export const IconCard = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="5" width="19" height="14" rx="2" />
    <path d="M2.5 10h19" /><path d="M6.5 15h3" />
  </Svg>
)

/* Panel-with-rail: the same glyph for collapse and expand, rotated by CSS.
   One icon means the button never appears to change identity mid-interaction. */
export const IconPanel = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M9.5 4v16" />
  </Svg>
)

export const IconMenu = (p: P) => (
  <Svg {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Svg>
)

export const IconClose = (p: P) => (
  <Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>
)

export const IconSignOut = (p: P) => (
  <Svg {...p}>
    <path d="M9.5 4.5H6A1.5 1.5 0 0 0 4.5 6v12A1.5 1.5 0 0 0 6 19.5h3.5" />
    <path d="M15 8.5 19 12l-4 3.5M19 12H9.5" />
  </Svg>
)

export const IconGear = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9L5.3 5.3" />
  </Svg>
)

/* ------------------------------------------------------------- app bar -- */

export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Svg>
)

export const IconBell = (p: P) => (
  <Svg {...p}>
    <path d="M18 8.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5" />
    <path d="M13.7 19a2 2 0 0 1-3.4 0" />
  </Svg>
)

export const IconSun = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M21.5 12h-2M4.5 12h-2M18.4 5.6 17 7M7 17l-1.4 1.4M18.4 18.4 17 17M7 7 5.6 5.6" />
  </Svg>
)

export const IconMoon = (p: P) => (
  <Svg {...p}>
    <path d="M20 14.3A8.2 8.2 0 0 1 9.7 4 8.5 8.5 0 1 0 20 14.3Z" />
  </Svg>
)

/* "Follow the operating system" — a display, not a light source. */
export const IconMonitor = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="19" height="13" rx="2" />
    <path d="M8.5 21h7M12 17v4" />
  </Svg>
)

export const IconAlert = (p: P) => (
  <Svg {...p}>
    <path d="M12 4.5 2.8 20h18.4L12 4.5Z" />
    <path d="M12 10v4M12 17.2v.1" />
  </Svg>
)

export const IconInfo = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8v.1" />
  </Svg>
)

export const IconCheck = (p: P) => (
  <Svg {...p}><path d="m4.5 12.5 5 5 10-11" /></Svg>
)

export const IconChevronRight = (p: P) => (
  <Svg {...p}><path d="m9.5 5.5 6.5 6.5-6.5 6.5" /></Svg>
)

export const IconChevronDown = (p: P) => (
  <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>
)

/* Enter, for the palette's "open this result" hint. */
export const IconReturn = (p: P) => (
  <Svg {...p}><path d="M20 5.5v5a3 3 0 0 1-3 3H4.5M8.5 9.5 4.5 13.5l4 4" /></Svg>
)

/* Speedometer — "how am I doing", not "what happened". Distinct from
   IconChart, which means a report someone else reads about you. */
export const IconGauge = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 17a9 9 0 1 1 17 0" />
    <path d="M12 17l4-5" />
    <circle cx="12" cy="17" r="1.2" />
  </Svg>
)

export const IconDownload = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.5v11M7.5 10.5 12 15l4.5-4.5" />
    <path d="M4.5 16.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2" />
  </Svg>
)

export const IconFilter = (p: P) => (
  <Svg {...p}><path d="M3.5 5.5h17l-6.5 7.5v6l-4 2v-8L3.5 5.5Z" /></Svg>
)

export const IconMail = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
    <path d="m3.5 7 8.5 6 8.5-6" />
  </Svg>
)

/* The app launcher's nine dots. Circles with an explicit fill rather than the
   sheet's stroke, because a 1.7px-stroked ring at r=1.1 renders as a smudge —
   this is the one glyph in the set that is solid by nature. */
export const IconGrid = (p: P) => (
  <Svg {...p}>
    {[5, 12, 19].map((cy) =>
      [5, 12, 19].map((cx) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.55" fill="currentColor" stroke="none" />
      )),
    )}
  </Svg>
)

export const IconPlus = (p: P) => (
  <Svg {...p}><path d="M12 5.5v13M5.5 12h13" /></Svg>
)

/* Favourites. Outlined, not filled: a filled star is the "this one is on"
   state, and every star this product draws is already on a tile that is. */
export const IconStar = (p: P) => (
  <Svg {...p}>
    <path d="m12 3.8 2.55 5.17 5.7.83-4.12 4.02.97 5.68L12 16.82l-5.1 2.68.97-5.68L3.75 9.8l5.7-.83Z" />
  </Svg>
)

/* A life ring — help, distinct from IconInfo, which this product uses for a
   fact you are being told rather than a place you can go for answers. */
export const IconLifebuoy = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="3.6" />
    <path d="m5.6 5.6 3.85 3.85M14.55 14.55l3.85 3.85M18.4 5.6l-3.85 3.85M9.45 14.55 5.6 18.4" />
  </Svg>
)

/* A paperclip — attach a file. Drawn as one open curve rather than the closed
   loop most icon sets use: at 16px the loop fills in and reads as a blob. */
export const IconPaperclip = (p: P) => (
  <Svg {...p}>
    <path d="M20.4 11.5 12 19.9a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
  </Svg>
)

/* A pencil — edit this record. Used on its own in table rows, so the button
   that holds it carries the aria-label rather than the glyph. */
export const IconEdit = (p: P) => (
  <Svg {...p}>
    <path d="M16.5 3.8a2.1 2.1 0 0 1 3 3L8 18.3l-4 1 1-4Z" />
    <path d="m14.5 5.8 3 3" />
  </Svg>
)
