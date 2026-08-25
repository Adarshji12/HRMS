/* MyDeskTime lockup.
 *
 * The mark is inlined rather than pulled from /logo-mark.svg via <img> so it
 * paints in the same frame as the rest of the shell — a 30px logo that pops in
 * one network round-trip late is the first thing anyone notices on a cold load.
 * public/logo-mark.svg stays the canonical copy for favicons, the manifest and
 * anything outside React; keep the two in sync if the geometry changes.
 */
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 512 512"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="brand-mark-fill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6C2BF0" />
          <stop offset="1" stopColor="#4A0FC0" />
        </linearGradient>
        <clipPath id="brand-mark-tile">
          <rect x="79" y="63" width="340" height="372" rx="64" />
        </clipPath>
      </defs>
      <rect x="93" y="77" width="340" height="372" rx="64" fill="#14004A" />
      <rect x="79" y="63" width="340" height="372" rx="64" fill="url(#brand-mark-fill)" />
      <g fill="none" strokeLinecap="round">
        <g stroke="#14004A" transform="translate(8 8)" clipPath="url(#brand-mark-tile)">
          <path d="M328.2 328.2A112 112 0 1 1 305 152" strokeWidth="14" />
          <path d="M156 249H249" strokeWidth="18" />
          <path d="M249 249V342" strokeWidth="18" />
          <path d="M249 249L351.9 162.6" strokeWidth="18" />
          <path d="M185.9 226A67.2 67.2 0 0 1 277.4 188.1" strokeWidth="6" />
        </g>
        <g stroke="#FFFFFF">
          <path d="M328.2 328.2A112 112 0 1 1 305 152" strokeWidth="14" />
          <path d="M156 249H249" strokeWidth="18" />
          <path d="M249 249V342" strokeWidth="18" />
          <path d="M249 249L351.9 162.6" strokeWidth="18" />
          <path d="M185.9 226A67.2 67.2 0 0 1 277.4 188.1" strokeWidth="6" />
        </g>
      </g>
    </svg>
  )
}

export default function Brand({ size = 30 }: { size?: number }) {
  return (
    <div className="brand">
      <BrandMark size={size} />
      {/* Split only to tint the halves — it is still one run of real text, so
          it reads as "MyDeskTime" and is selectable and searchable. */}
      <span className="brand-word">
        <span className="word-a">MyDesk</span>
        <span className="word-b">Time</span>
      </span>
    </div>
  )
}
