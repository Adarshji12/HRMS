import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

interface TooltipContent {
  title: string
  rows: Array<[string, string]>
}

interface TooltipApi {
  show: (event: { clientX: number; clientY: number }, content: TooltipContent) => void
  hide: () => void
}

const Ctx = createContext<TooltipApi>({ show: () => {}, hide: () => {} })

export function useTooltip(): TooltipApi {
  return useContext(Ctx)
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ x: number; y: number; content: TooltipContent } | null>(null)

  const show: TooltipApi['show'] = useCallback((event, content) => {
    setState({ x: event.clientX, y: event.clientY, content })
  }, [])
  const hide = useCallback(() => setState(null), [])
  const api = useMemo(() => ({ show, hide }), [show, hide])

  // Flip to the other side of the cursor near the viewport edge so the tooltip
  // is never clipped by the window.
  const flipX = state ? state.x > window.innerWidth - 300 : false
  const flipY = state ? state.y > window.innerHeight - 140 : false

  return (
    <Ctx.Provider value={api}>
      {children}
      {state && (
        <div
          className="tooltip"
          role="status"
          style={{
            left: flipX ? undefined : state.x + 14,
            right: flipX ? window.innerWidth - state.x + 14 : undefined,
            top: flipY ? undefined : state.y + 14,
            bottom: flipY ? window.innerHeight - state.y + 14 : undefined,
          }}
        >
          <div className="tooltip-title">{state.content.title}</div>
          {state.content.rows.map(([label, value]) => (
            <div className="tooltip-row" key={label}>
              <span>{label}</span>
              <b>{value}</b>
            </div>
          ))}
        </div>
      )}
    </Ctx.Provider>
  )
}
