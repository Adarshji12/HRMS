/* Proof verification — HR's side of income tax.

   The screen exists for one window in the year, usually January and February,
   when proofs are collected against what people declared in April. What it has
   to make easy is the comparison: declared against evidenced, per section, for
   everybody at once.

   Two things it deliberately does not offer:

   * **No way to change somebody's regime.** The choice is the employee's, with
     consequences they own, and there is no server route for it either.
   * **No way to enter a claim on somebody's behalf.** A declaration filled in by
     HR is not a declaration; it is an assumption with the employee's name on it.

   Verifying a lower amount than declared is the ordinary case, not an
   exception — somebody declared ₹1,50,000 in April and produced receipts for
   ₹1,10,000 — so the input defaults to the declared figure and is editable
   rather than being a yes/no. */

import { useCallback, useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { money, toPaise } from '../../../lib/format'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type { TaxDeclaration, TaxItem } from '../../../lib/types'
import '../../../styles/payroll.css'

export default function TaxVerification() {
  const listQ = useQuery<TaxDeclaration[]>('tax-declarations', () =>
    api.get<TaxDeclaration[]>('/tax/declarations'),
  )
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const act = useCallback(
    async (run: () => Promise<unknown>) => {
      setBusy(true)
      setError(null)
      try {
        await run()
        listQ.reload()
      } catch (caught) {
        setError((caught as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [listQ],
  )

  if (listQ.loading) return <Loading />
  if (listQ.error) return <ErrorNote>{listQ.error}</ErrorNote>

  const rows = listQ.data ?? []
  const waiting = rows.filter((row) => row.status === 'submitted').length

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Tax declarations</h1>
          <p className="muted">
            Check proofs against what people declared. Payroll switches to the
            verified figure the month you set it — which is when they will ask.
          </p>
        </div>
        <div className="ex-headline">{waiting} awaiting verification</div>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}

      {!rows.length ? (
        <Empty>Nobody has started a declaration for this year.</Empty>
      ) : (
        <div className="ln-list">
          {rows.map((row) => (
            <div key={row.id} className={`ln-card${open === row.id ? ' is-open' : ''}`}>
              <button className="ln-card-head" onClick={() =>
                setOpen(open === row.id ? null : row.id)}>
                <div className="ln-card-title">
                  <div className="pr-title">{row.user_name}</div>
                  <div className="muted">
                    {row.regime === 'new' ? 'New regime' : 'Old regime'} ·{' '}
                    {row.items.length} {row.items.length === 1 ? 'claim' : 'claims'}
                    {row.regime === 'new' && row.items.length > 0
                      ? ' · none of them count under the new regime' : ''}
                  </div>
                </div>
                <div className="ln-card-amount">
                  {money(row.items.reduce((sum, i) => sum + i.effective_amount, 0))}
                  <div className="ln-sub">counted</div>
                </div>
                <span className={`pr-status pr-status-${
                  row.status === 'verified' ? 'ok'
                    : row.status === 'submitted' ? 'go'
                      : row.status === 'rejected' ? 'bad' : 'muted'}`}>
                  {row.status.replace(/^./, (c) => c.toUpperCase())}
                </span>
              </button>

              {open === row.id && (
                <div className="ln-card-body">
                  {!row.items.length ? (
                    <Empty>Nothing declared.</Empty>
                  ) : (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Section</th><th className="num">Declared</th>
                            <th>Proof</th><th className="num">Verified</th><th />
                          </tr>
                        </thead>
                        <tbody>
                          {row.items.map((item) => (
                            <VerifyRow key={item.id} item={item} busy={busy} act={act} />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div className="pr-actions">
                    {row.status !== 'verified' ? (
                      <button className="btn primary" disabled={busy}
                              onClick={() => act(() =>
                                api.post(`/tax/declaration/${row.id}/close`, {}))}>
                        Mark verified
                      </button>
                    ) : (
                      <button className="btn" disabled={busy}
                              onClick={() => act(() =>
                                api.post(`/tax/declaration/${row.id}/close`,
                                         { reopen: true }))}>
                        Reopen
                      </button>
                    )}
                    <span className="muted">
                      {row.status === 'verified'
                        ? 'Closed. Reopen it if somebody produces a receipt late.'
                        : 'Closing stops the employee editing it.'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function VerifyRow({
  item,
  busy,
  act,
}: {
  item: TaxItem
  busy: boolean
  act: (run: () => Promise<unknown>) => Promise<void>
}) {
  /* Defaults to the declared figure and stays editable: verifying a lower
     amount is the ordinary case, not an exception, so this is a number field
     rather than an accept/reject pair. */
  const [amount, setAmount] = useState(() => String(item.declared_amount / 100))
  const [note, setNote] = useState('')
  const paise = toPaise(amount)

  return (
    <tr>
      <td>
        <div className="pr-code">{item.section}</div>
        <div className="muted">{item.label ?? ''}</div>
      </td>
      <td className="num">
        {money(item.declared_amount)}
        {item.cap !== null && item.declared_amount > item.cap && (
          <div className="pr-warn">capped at {money(item.cap)}</div>
        )}
      </td>
      <td>
        {item.document_id ? (
          <span className="pr-yes">✓ attached</span>
        ) : (
          <span className="muted">none</span>
        )}
      </td>
      <td className="num">
        {item.verified_amount === null
          ? <span className="muted">not checked</span>
          : item.status === 'rejected'
            ? <span className="ln-bad">rejected</span>
            : money(item.verified_amount)}
      </td>
      <td className="row-actions">
        <input className="pr-amount" value={amount} inputMode="decimal"
               aria-label={`Verified amount for ${item.section}`}
               onChange={(e) => setAmount(e.target.value)} />
        <button className="btn small primary" disabled={busy || paise === null}
                onClick={() => act(() =>
                  api.post(`/tax/items/${item.id}/verify`,
                           { verified_amount: paise }))}>
          Accept
        </button>
        <input placeholder="Reason to reject" value={note}
               aria-label={`Rejection reason for ${item.section}`}
               onChange={(e) => setNote(e.target.value)} />
        <button className="btn small danger" disabled={busy || !note.trim()}
                onClick={() => act(() =>
                  api.post(`/tax/items/${item.id}/verify`,
                           { reject: true, note }))}>
          Reject
        </button>
      </td>
    </tr>
  )
}
