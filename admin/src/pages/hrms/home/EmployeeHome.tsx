import { useMemo } from 'react'
import {
  canAdminister,
  canApproveSomething,
  canViewTeam,
  isOwner,
  useAuth,
} from '../../../lib/auth'
import type { NavAccess } from '../../../lib/nav'
import Welcome from './Welcome'

/**
 * `/home` — the Welcome panel, and nothing else.
 *
 * It used to sit beside a Dashboard tab of six status cards. That tab is gone,
 * so there is no switch to render: Home is the door to the things people come
 * here to do — punch, apply, look up a payslip.
 */
export default function EmployeeHome() {
  const { user } = useAuth()

  /* Rebuilt here rather than threaded through the router: the shell computes
     the same object for the rail, and a prop chain through <Routes> to reach
     one page would be a second definition of it in the router's signature.
     Same helpers, same source of truth — `lib/auth`. */
  const access = useMemo<NavAccess>(
    () => ({
      isAdmin: canAdminister(user),
      canViewTeam: canViewTeam(user),
      isOwner: isOwner(user),
      canApprove: canApproveSomething(user),
      hiddenPages: user?.hidden_pages ?? [],
      menuRights: user?.menu_rights ?? null,
    }),
    [user],
  )

  return <Welcome access={access} />
}
