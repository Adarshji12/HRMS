/* The company directory — find a colleague.

   Open to every employee, and that is safe because of the *shape* of what the
   server returns, not because of who may call it. `DirectoryEntryOut` carries
   work contact details and nothing else: no date of birth, no address, no
   statutory field. Widening the audience therefore cannot widen the disclosure,
   which is the property that lets this be the one People page an employee can
   open.

   Clicking a person navigates to their profile, which *is* permission-checked —
   an employee lands on a 403 there, and that is the correct place for the
   refusal. Hiding the link instead would leave the data reachable while making
   the product feel arbitrary. */

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import { useAuth } from '../../../lib/auth'
import type { DirectoryEntry } from '../../../lib/types'
import '../../../styles/people.css'

export default function Directory() {
  const { user } = useAuth()
  const [term, setTerm] = useState('')
  const dirQ = useQuery<DirectoryEntry[]>('people-directory', () =>
    api.get<DirectoryEntry[]>('/people/directory'),
  )

  /* Filtered in the browser rather than round-tripping per keystroke. The
     server takes a `q` for the case where a company outgrows the 500-row cap;
     below that, a local filter is instant and the whole list is already here. */
  const rows = useMemo(() => {
    const needle = term.trim().toLowerCase()
    if (!needle || !dirQ.data) return dirQ.data ?? []
    return dirQ.data.filter((row) =>
      [row.full_name, row.email, row.employee_code, row.designation, row.department, row.team]
        .filter(Boolean)
        .some((field) => field!.toLowerCase().includes(needle)),
    )
  }, [dirQ.data, term])

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Directory</h1>
          <p className="muted">Everyone at this company, with their work contact details.</p>
        </div>
        <input
          className="hr-search"
          value={term}
          placeholder="Search name, email, code, team…"
          onChange={(event) => setTerm(event.target.value)}
          aria-label="Search the directory"
        />
      </header>

      {dirQ.loading ? (
        <Loading />
      ) : dirQ.error ? (
        <ErrorNote>{dirQ.error}</ErrorNote>
      ) : !rows.length ? (
        <Empty>{term ? 'Nobody matches that.' : 'No colleagues listed yet.'}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th><th>Designation</th><th>Department</th>
                <th>Team</th><th>Reports to</th><th>Contact</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.user_id}>
                  <td>
                    <Link
                      to={row.user_id === user?.id ? '/profile' : `/people/${row.user_id}`}
                      className="hr-doc-name"
                    >
                      {row.full_name}
                    </Link>
                    {row.employee_code && <div className="muted">{row.employee_code}</div>}
                  </td>
                  <td>{row.designation ?? '—'}</td>
                  <td>{row.department ?? '—'}</td>
                  <td>{row.team ?? '—'}</td>
                  <td>{row.manager_name ?? '—'}</td>
                  <td>
                    <a href={`mailto:${row.email}`}>{row.email}</a>
                    {row.phone && <div className="muted">{row.phone}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
