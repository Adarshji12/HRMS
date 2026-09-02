/* Running an appraisal round, and writing the manager's half of one.
 *
 * One page rather than two, because the two audiences overlap almost entirely:
 * the person who opens the cycle is usually the person finalising it, and a
 * manager writing their team's reviews needs to see the round's state to know
 * whether it is worth starting.
 *
 * What the page is careful about:
 *
 * **The score is evidence, not the decision.** The weighted figure is shown
 * next to the overall rating, and when they differ by a whole point the reason
 * field appears *before* the finalise button rather than as an error after it.
 * The server enforces this; the page makes complying the path of least
 * resistance.
 *
 * **Finalising and sharing are separate.** They are separate on the server for
 * a reason — HR finalises a batch and releases it once the increment letters
 * are ready — so the page offers both rather than collapsing them into one
 * button that quietly does more than it says.
 */

import { useEffect, useMemo, useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type {
  Competency,
  PerformanceReview,
  ReviewCycle,
} from '../../../lib/types'
import { RatingPicker, STATUS_LABEL, rating, weight } from './MyReview'
import './performance.css'

export default function Appraisals() {
  const cyclesQ = useQuery<ReviewCycle[]>('perf-admin-cycles', () =>
    api.get<ReviewCycle[]>('/performance/cycles'),
  )
  const [cycleId, setCycleId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const cycles = cyclesQ.data ?? []
  useEffect(() => {
    if (!cycleId && cycles.length) setCycleId(cycles[0].id)
  }, [cycleId, cycles])
  const cycle = cycles.find((c) => c.id === cycleId) ?? null

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Appraisals</h1>
          <p className="muted">
            Run a review round: set goals, collect both halves, finalise the
            ratings and release them.
          </p>
        </div>
        <button className="btn primary" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Close' : 'New cycle'}
        </button>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}
      {creating && (
        <NewCycle
          onDone={(id) => { setCreating(false); setCycleId(id); cyclesQ.reload() }}
          onError={setError}
        />
      )}

      {cyclesQ.loading ? (
        <Loading />
      ) : cyclesQ.error ? (
        <ErrorNote>{cyclesQ.error}</ErrorNote>
      ) : !cycles.length ? (
        <Empty>No appraisal cycles yet. Start one to set goals and collect reviews.</Empty>
      ) : (
        <>
          <div className="perf-cycle-tabs">
            {cycles.map((c) => (
              <button
                key={c.id}
                className={`chip${c.id === cycleId ? ' is-on' : ''}`}
                onClick={() => setCycleId(c.id)}
              >
                {c.name}
                <span className={`perf-pill perf-cycle-${c.status}`}>{c.status}</span>
              </button>
            ))}
          </div>
          {cycle && (
            <CycleBody
              cycle={cycle}
              onChanged={cyclesQ.reload}
              onError={setError}
            />
          )}
        </>
      )}

      <Competencies onError={setError} />
    </div>
  )
}

function NewCycle({
  onDone,
  onError,
}: {
  onDone: (id: string) => void
  onError: (message: string) => void
}) {
  const [form, setForm] = useState({
    name: '',
    period_start: '',
    period_end: '',
    rating_max: 5,
    requires_self_review: true,
    weights_must_total: true,
  })
  const [busy, setBusy] = useState(false)

  return (
    <section className="card perf-form">
      <h2 className="card-title">New cycle</h2>
      <div className="perf-row">
        <label className="perf-field">
          <span className="perf-field-label">Name</span>
          <input
            value={form.name}
            placeholder="FY2025-26 Annual"
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className="perf-field">
          <span className="perf-field-label">Period from</span>
          <input type="date" value={form.period_start}
                 onChange={(e) => setForm({ ...form, period_start: e.target.value })} />
          <span className="perf-field-hint">
            The period being appraised, not the window for doing the appraising.
          </span>
        </label>
        <label className="perf-field">
          <span className="perf-field-label">to</span>
          <input type="date" value={form.period_end}
                 onChange={(e) => setForm({ ...form, period_end: e.target.value })} />
        </label>
        <label className="perf-field">
          <span className="perf-field-label">Rating scale</span>
          <select value={form.rating_max}
                  onChange={(e) => setForm({ ...form, rating_max: Number(e.target.value) })}>
            {[3, 4, 5, 10].map((n) => <option key={n} value={n}>1 to {n}</option>)}
          </select>
        </label>
      </div>
      <label className="perf-check">
        <input type="checkbox" checked={form.requires_self_review}
               onChange={(e) => setForm({ ...form, requires_self_review: e.target.checked })} />
        <span>
          The employee writes first. Turn this off for a manager-only round —
          common for probation reviews.
        </span>
      </label>
      <label className="perf-check">
        <input type="checkbox" checked={form.weights_must_total}
               onChange={(e) => setForm({ ...form, weights_must_total: e.target.checked })} />
        <span>
          Goal weights must total 100%. Turn this off for a round rated on
          competencies, where goals are context rather than the score.
        </span>
      </label>
      <div className="perf-actions">
        <button
          className="btn primary"
          disabled={busy || !form.name || !form.period_start || !form.period_end}
          onClick={async () => {
            setBusy(true)
            try {
              const made = await api.post<ReviewCycle>('/performance/cycles', form)
              onDone(made.id)
            } catch (caught) {
              onError((caught as Error).message)
            } finally {
              setBusy(false)
            }
          }}
        >
          Create
        </button>
        <span className="muted">
          It starts as a draft — employees see nothing until you open it.
        </span>
      </div>
    </section>
  )
}

function CycleBody({
  cycle,
  onChanged,
  onError,
}: {
  cycle: ReviewCycle
  onChanged: () => void
  onError: (message: string | null) => void
}) {
  const reviewsQ = useQuery<PerformanceReview[]>(`perf-reviews-${cycle.id}`, () =>
    api.get<PerformanceReview[]>(`/performance/cycles/${cycle.id}/reviews`),
  )
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    onError(null)
    try {
      await fn()
      reviewsQ.reload()
      onChanged()
    } catch (caught) {
      onError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const reviews = reviewsQ.data ?? []
  const waiting = reviews.filter((r) => r.status === 'manager_submitted')

  return (
    <>
      <section className="card">
        <div className="perf-cycle-head">
          <div>
            <h2 className="card-title">{cycle.name}</h2>
            <p className="muted">
              {cycle.period_start} to {cycle.period_end} · rated 1 to{' '}
              {cycle.rating_max} · {cycle.review_count} review
              {cycle.review_count === 1 ? '' : 's'}, {cycle.finalised_count}{' '}
              finalised
            </p>
          </div>
          <div className="perf-actions">
            {cycle.status === 'draft' && (
              <button className="btn primary" disabled={busy}
                      onClick={() => act(() =>
                        api.post(`/performance/cycles/${cycle.id}/status`,
                                 { status: 'open' }))}>
                Open the round
              </button>
            )}
            {cycle.status === 'open' && (
              <>
                <button className="btn" disabled={busy}
                        onClick={() => act(() =>
                          api.post(`/performance/cycles/${cycle.id}/open-reviews`,
                                   { user_ids: [] }))}>
                  Create reviews
                </button>
                <button className="btn" disabled={busy}
                        onClick={() => act(() =>
                          api.post(`/performance/cycles/${cycle.id}/status`,
                                   { status: 'closed' }))}>
                  Close the round
                </button>
              </>
            )}
          </div>
        </div>
        {cycle.status === 'closed' && (
          <p className="muted">
            Closed — nothing can be written to it. Closing is one-way; start a
            new cycle rather than reopening a round somebody's increment was
            decided from.
          </p>
        )}
        {waiting.length > 0 && (
          <p className="muted">
            {waiting.length} review{waiting.length === 1 ? '' : 's'} waiting to
            be finalised.
          </p>
        )}
      </section>

      {reviewsQ.loading ? (
        <Loading />
      ) : !reviews.length ? (
        <Empty>
          No reviews in this cycle yet. “Create reviews” opens one per active
          employee — running it twice is harmless.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th><th>Manager</th><th>Status</th>
                <th className="num">Score</th><th className="num">Rating</th><th />
              </tr>
            </thead>
            <tbody>
              {reviews.map((review) => (
                <tr key={review.id}>
                  <td>{review.user_name}</td>
                  <td className="muted">{review.manager_name ?? '—'}</td>
                  <td>
                    <span className={`perf-pill perf-${review.status}`}>
                      {STATUS_LABEL[review.status] ?? review.status}
                    </span>
                    {review.status === 'finalised' && !review.shared_at && (
                      <span className="muted"> · not released</span>
                    )}
                  </td>
                  <td className="num">
                    {rating(review.score_centi ?? review.live_score_centi)}
                  </td>
                  <td className="num">{review.overall_rating ?? '—'}</td>
                  <td className="row-actions">
                    <button className="btn small"
                            onClick={() => setOpen(open === review.id ? null : review.id)}>
                      {open === review.id ? 'Hide' : 'Open'}
                    </button>
                    {review.status === 'manager_submitted' && (
                      <button className="btn small" disabled={busy}
                              onClick={() => act(() =>
                                api.post(`/performance/reviews/${review.id}/finalise`,
                                         { share: false }))}>
                        Finalise
                      </button>
                    )}
                    {review.status === 'finalised' && !review.shared_at && (
                      <button className="btn small" disabled={busy}
                              onClick={() => act(() =>
                                api.post(`/performance/reviews/${review.id}/share`, {}))}>
                        Release
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <ManagerReview
          reviewId={open}
          cycle={cycle}
          onChanged={() => { reviewsQ.reload(); onChanged() }}
          onError={onError}
        />
      )}
    </>
  )
}

function ManagerReview({
  reviewId,
  cycle,
  onChanged,
  onError,
}: {
  reviewId: string
  cycle: ReviewCycle
  onChanged: () => void
  onError: (message: string | null) => void
}) {
  const reviewQ = useQuery<PerformanceReview>(`perf-review-${reviewId}`, () =>
    api.get<PerformanceReview>(`/performance/reviews/${reviewId}`),
  )
  const [ratings, setRatings] = useState<Record<string, number | null>>({})
  const [comments, setComments] = useState<Record<string, string>>({})
  const [overallRating, setOverallRating] = useState<number | null>(null)
  const [finalComment, setFinalComment] = useState('')
  const [overrideReason, setOverrideReason] = useState('')
  const [busy, setBusy] = useState(false)

  const review = reviewQ.data

  useEffect(() => {
    if (!review) return
    setRatings(Object.fromEntries(review.goals.map((g) => [g.id, g.manager_rating])))
    setComments(Object.fromEntries(
      review.goals.map((g) => [g.id, g.manager_comment ?? '']),
    ))
    setOverallRating(review.overall_rating)
    setFinalComment(review.final_comment ?? '')
    setOverrideReason(review.override_reason ?? '')
  }, [review])

  /* Recomputed here as the manager rates, so the figure the finalise button
     will be judged against is on screen while they are still deciding. Same
     arithmetic as the server: weights renormalised over the goals actually
     rated, one division at the end. */
  const liveScore = useMemo(() => {
    if (!review) return null
    const rated = review.goals
      .map((g) => [g.weight_bps, ratings[g.id]] as const)
      .filter(([w, r]) => r !== null && r !== undefined && w > 0)
    if (!rated.length) return null
    const totalWeight = rated.reduce((sum, [w]) => sum + w, 0)
    return Math.floor(
      (rated.reduce((sum, [w, r]) => sum + w * (r as number), 0) * 100) / totalWeight,
    )
  }, [review, ratings])

  if (reviewQ.loading) return <Loading />
  if (reviewQ.error) return <ErrorNote>{reviewQ.error}</ErrorNote>
  if (!review) return null

  const frozen = review.status === 'finalised'
  const gap =
    overallRating !== null && liveScore !== null
      ? Math.abs(overallRating * 100 - liveScore)
      : 0
  const needsReason = gap >= 100

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    onError(null)
    try {
      await fn()
      reviewQ.reload()
      onChanged()
    } catch (caught) {
      onError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const save = () =>
    api.post(`/performance/reviews/${review.id}/manager`, {
      goals: review.goals.map((g) => ({
        goal_id: g.id,
        rating: ratings[g.id] ?? null,
        comment: comments[g.id] || null,
      })),
      comment: finalComment || null,
      overall_rating: overallRating,
      override_reason: overrideReason || null,
    })

  return (
    <section className="card perf-manager">
      <h2 className="card-title">
        {review.user_name} — {review.cycle_name}
      </h2>

      {review.self_comment && (
        <blockquote className="perf-quote">{review.self_comment}</blockquote>
      )}

      {review.goals.map((goal) => (
        <div className="perf-goal" key={goal.id}>
          <div className="perf-goal-head">
            <div className="perf-goal-title">{goal.title}</div>
            <span className="perf-weight">{weight(goal.weight_bps)}</span>
          </div>
          {goal.self_rating !== null && (
            <div className="perf-self-view">
              Self: <strong>{goal.self_rating}</strong>
              {goal.self_comment && <span> — {goal.self_comment}</span>}
            </div>
          )}
          <RatingPicker
            value={ratings[goal.id] ?? null}
            max={cycle.rating_max}
            labels={cycle.rating_labels}
            disabled={frozen}
            onPick={(value) => setRatings((p) => ({ ...p, [goal.id]: value }))}
          />
          <textarea
            rows={2}
            disabled={frozen}
            placeholder="Your assessment"
            value={comments[goal.id] ?? ''}
            onChange={(e) => setComments((p) => ({ ...p, [goal.id]: e.target.value }))}
          />
        </div>
      ))}

      <div className="perf-overall">
        <div>
          <span className="perf-field-label">Weighted score</span>
          <div className="perf-final-value">{rating(liveScore)}</div>
          <span className="muted">Evidence, not the decision.</span>
        </div>
        <div>
          <span className="perf-field-label">Overall rating</span>
          <RatingPicker
            value={overallRating}
            max={cycle.rating_max}
            labels={cycle.rating_labels}
            disabled={frozen}
            onPick={setOverallRating}
          />
        </div>
      </div>

      {/* Appears before the finalise button, not as an error after it: the
          server refuses without a reason and the page makes complying the path
          of least resistance. */}
      {needsReason && !frozen && (
        <label className="perf-field">
          <span className="perf-field-label">
            Why the rating differs from the score
          </span>
          <textarea
            rows={2}
            value={overrideReason}
            placeholder="The score says one thing and you are saying another — say why."
            onChange={(e) => setOverrideReason(e.target.value)}
          />
        </label>
      )}

      <label className="perf-field">
        <span className="perf-field-label">Closing comment</span>
        <textarea rows={3} disabled={frozen} value={finalComment}
                  onChange={(e) => setFinalComment(e.target.value)} />
      </label>

      {!frozen && (
        <div className="perf-actions">
          <button className="btn" disabled={busy} onClick={() => act(save)}>
            Save
          </button>
          {review.status === 'self_submitted' && (
            <>
              <button className="btn primary" disabled={busy}
                      onClick={() => act(async () => {
                        await save()
                        await api.post(`/performance/reviews/${review.id}/decision`,
                                       { approve: true })
                      })}>
                Pass on to HR
              </button>
              <button className="btn" disabled={busy || !finalComment}
                      onClick={() => act(() =>
                        api.post(`/performance/reviews/${review.id}/decision`,
                                 { approve: false, note: finalComment }))}>
                Send back
              </button>
              <span className="muted">
                Sending back needs a reason — the closing comment is used.
              </span>
            </>
          )}
        </div>
      )}
    </section>
  )
}

function Competencies({ onError }: { onError: (m: string | null) => void }) {
  const listQ = useQuery<Competency[]>('perf-competencies', () =>
    api.get<Competency[]>('/performance/competencies?include_inactive=true'),
  )
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <section className="card">
      <h2 className="card-title">Competencies</h2>
      <p className="muted">
            What the company rates people on, beyond their goals.
          </p>
      <div className="perf-row">
        <input
          value={name}
          placeholder="Ownership"
          onChange={(e) => setName(e.target.value)}
        />
        <button className="btn" disabled={busy || !name.trim()}
                onClick={async () => {
                  setBusy(true)
                  onError(null)
                  try {
                    await api.post('/performance/competencies', { name: name.trim() })
                    setName('')
                    listQ.reload()
                  } catch (caught) {
                    onError((caught as Error).message)
                  } finally {
                    setBusy(false)
                  }
                }}>
          Add
        </button>
      </div>
      {listQ.data?.length ? (
        <ul className="perf-competencies">
          {listQ.data.map((c) => (
            <li key={c.id} className={c.is_active ? undefined : 'is-off'}>
              {c.name}
              <button className="btn small" onClick={async () => {
                await api.patch(`/performance/competencies/${c.id}`,
                                { is_active: !c.is_active })
                listQ.reload()
              }}>
                {c.is_active ? 'Deactivate' : 'Reactivate'}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>None yet. Goals alone are a complete appraisal for many companies.</Empty>
      )}
    </section>
  )
}
