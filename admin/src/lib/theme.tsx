import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

/**
 * Appearance.
 *
 * Three states, not two. "System" is the default and it is a real choice, not
 * the absence of one — someone whose desk flips to dark at sunset wants the
 * console to follow, and a two-way toggle cannot express that.
 *
 * The stylesheet already handled all three before anything set them:
 *   system → no attribute, so the prefers-color-scheme block decides
 *   light  → [data-theme='light'], which that block explicitly excludes
 *   dark   → [data-theme='dark']
 * So this only has to write the attribute; the tokens were always there.
 */
export type ThemeMode = 'system' | 'light' | 'dark'

const KEY = 'hrdesktimesol.theme'
const MODES: ThemeMode[] = ['system', 'light', 'dark']

interface ThemeState {
  mode: ThemeMode
  /** What is actually on screen right now — 'system' resolved against the OS. */
  resolved: 'light' | 'dark'
  setMode: (mode: ThemeMode) => void
  /** system → light → dark → system, for a single-button control. */
  cycle: () => void
}

const Ctx = createContext<ThemeState>({
  mode: 'system',
  resolved: 'light',
  setMode: () => {},
  cycle: () => {},
})

export function useTheme(): ThemeState {
  return useContext(Ctx)
}

function stored(): ThemeMode {
  const value = localStorage.getItem(KEY)
  return MODES.includes(value as ThemeMode) ? (value as ThemeMode) : 'light'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(stored)
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )

  // The OS can flip while the tab is open, and on 'system' that has to land
  // immediately — otherwise the console is the one window still bright at dusk.
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    if (mode === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', mode)
    localStorage.setItem(KEY, mode)
  }, [mode])

  const setMode = useCallback((next: ThemeMode) => setModeState(next), [])
  const cycle = useCallback(
    () => setModeState((current) => MODES[(MODES.indexOf(current) + 1) % MODES.length]),
    [],
  )

  const resolved: 'light' | 'dark' =
    mode === 'system' ? (systemDark ? 'dark' : 'light') : mode

  const value = useMemo(
    () => ({ mode, resolved, setMode, cycle }),
    [mode, resolved, setMode, cycle],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
