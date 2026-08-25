import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, getToken, setToken } from './api'
import { getSlug, setSlug } from './tenant'
import type { TenantInfo, User } from './types'

interface AuthState {
  user: User | null
  organization: TenantInfo | null
  ready: boolean
  /** `slug` is only needed where the hostname does not already name the tenant. */
  login: (email: string, password: string, slug?: string) => Promise<void>
  logout: () => void
}

const Ctx = createContext<AuthState>({
  user: null,
  organization: null,
  ready: false,
  login: async () => {},
  logout: () => {},
})

export function useAuth(): AuthState {
  return useContext(Ctx)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [organization, setOrganization] = useState<TenantInfo | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    async function restore() {
      if (!getSlug()) {
        // No tenant known yet — the sign-in page will ask for one. Calling the
        // API now would only produce a "no tenant" error.
        setReady(true)
        return
      }
      try {
        setOrganization(await api.get<TenantInfo>('/auth/tenant'))
      } catch {
        // Stored slug points at an organisation that no longer exists.
        setSlug(null)
        setReady(true)
        return
      }
      if (getToken()) {
        try {
          setUser(await api.get<User>('/auth/me'))
        } catch {
          setToken(null)
        }
      }
      setReady(true)
    }
    void restore()
  }, [])

  const login = useCallback(async (email: string, password: string, slug?: string) => {
    // Set the slug before the request: the API client reads it to build the
    // tenant header this very call depends on.
    if (slug) setSlug(slug)
    try {
      const result = await api.post<{ access_token: string; organization: TenantInfo }>(
        '/auth/login',
        { email, password },
      )
      setToken(result.access_token)
      setOrganization(result.organization)
      setUser(await api.get<User>('/auth/me'))
    } catch (err) {
      // Do not leave a bad slug behind for the next attempt.
      if (slug) setSlug(null)
      throw err
    }
  }, [])

  const logout = useCallback(() => {
    setToken(null)
    setUser(null)
    // The slug is kept: signing out should not make the user retype which
    // company they work for.
    window.location.href = '/login'
  }, [])

  const value = useMemo(
    () => ({ user, organization, ready, login, logout }),
    [user, organization, ready, login, logout],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function canAdminister(user: User | null): boolean {
  return user?.role === 'owner' || user?.role === 'admin'
}

/** The account holder. Mirrors require_owner on the server. */
export function isOwner(user: User | null): boolean {
  return user?.role === 'owner'
}

/** Mirrors Role.can_view_team on the server — owner, admin or manager. */
export function canViewTeam(user: User | null): boolean {
  return canAdminister(user) || user?.role === 'manager'
}

/**
 * Whether this person decides *anything* — which is not the same question as
 * whether they can see a team.
 *
 * The approvals inbox used to be gated on `canViewTeam`, which was right while
 * it held leave, attendance and timesheets: all three are a manager's business.
 * Expenses and loans are not. Somebody in finance who sanctions spending is
 * routinely nobody's manager, and gating their queue on team visibility would
 * hide their own work from them.
 *
 * Permission flags **restrict** rather than grant here, matching the server:
 * an employee with `can_approve_expenses` still only sees claims the expenses
 * service is willing to show them, which for an employee is none.
 */
export function canApproveSomething(user: User | null): boolean {
  if (canViewTeam(user)) return true
  return Boolean(
    user &&
      (user.can_approve_expenses ||
        user.can_approve_loans ||
        user.can_approve_leave ||
        user.can_approve_regularization ||
        user.can_approve_timesheets),
  )
}
