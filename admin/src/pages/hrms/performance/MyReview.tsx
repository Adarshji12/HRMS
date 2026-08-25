/* The employee's own appraisal.
 *
 * Three things this page is careful about, all of them about trust:
 *
 * 1. **It shows what the weights mean.** A goal weighted 3000 basis points is
 *    rendered as 30%, and the running total is on screen while the goals are
 *    being rated — because the server refuses a submission whose weights do not
 *    come to 100%, and finding that out at the submit button is finding out too
 *    late.
 *
 * 2. **It never invents a rating.** An unrated goal shows as unrated, not as
 *    zero. The server keeps "not rated" and "rated lowest" apart and so does
 *    this: a slider defaulting to 1 would put a rating on somebody's record
 *    that they did not choose.
 *
 * 3. **It does not show a manager's rating that has not been shared.** The
 *    server removes those fields rather than flagging them, so there is nothing
 *    here to leak — but the page says *why* the section is empty, because a
 *    blank panel after a finalised review reads as a bug.
 */

import { useEffect, useMemo, useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type { PerformanceReview, ReviewCycle } from '../../../lib/types'
import './performance.css'

/** Basis points as a percentage. 3000 → "30%". */
export function weight(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`
}

/** Hundredths as a rating. 370 → "3.70". */
export function rating(centi: number | null | undefined): string {
  return centi === null || centi === undefined ? '—' : (centi / 100).toFixed(2)
}

/** The label for a point on the scale, when the cycle named its points. */
export function ratingLabel(
  value: number | null,
  labels: string[] | null,
): string | null {
  if (value === null || !labels || value < 1 || value > labels.length) return null
  return labels[value - 1]
}

export function RatingPicker({
  value,
  max,
  labels,
  disabled,
  onPick,
}: {
  value: number | null
  max: number
  labels: string[] | null
  disabled?: boolean
  onPick: (value: number | null) => void
}) {
  return (
    <div className="pf-scale">
      {Array.from({ length: max }, (_, i) => i + 1).map((point) => (
        <button
          key={point}
          type="button"
          disabled={disabled}
          className={`pf-point${value === point ? ' is-on' : ''}`}
          title={ratingLabel(point, labels) ?? `${point}`}
          /* Clicking the chosen point clears it. There has to be a way back
             from a rating somebody set by accident, and "not rated" is a state
             the server keeps rather than a gap it fills with 1. */
          onClick={() => onPick(value === point ? null : point)}
        >
          {point}
        </button>
      ))}
      <span className="pf-scale-label">
        {value === null ? 'Not rated' : ratingLabel(value, labels) ?? ''}
      </span>
    </div>
  )
}

export default function MyReview() {
  const cycles = useQuery<ReviewCycle[]>('perf-cycles', () =>
    api.get<ReviewCycle[]>('/performance/cycles'),
  )
  const [cycleId, setCycleId] = useState<string | null>(null)

  const open = useMemo(
    () => (cycles.data ?? []).filter((c) => c.status !== 'draft'),
    [cycles.data],
  )
  useEffect(() => {
    if (!cycleId && open.length) setCycleId(open[0].id)
  }, [cycleId, open])

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>My review</h1>
          <p className="muted">
            Your own half of the appraisal. Your manager cannot edit what you
            write here.
          </p>
        </div>
        {open.length > 1 && (
          <select value={cycleId ?? ''} onChange={(e) => setCycleId(e.target.value)}>
            {open.map((cycle) => (
              <option key={cycle.id} value={cycle.id}>{cycle.name}</option>
            ))}
          </select>
        )}
      </header>

      {cycles.loading ? (
        <Loading />
      ) : cycles.error ? (
        <ErrorNote>{cycles.error}</ErrorNote>
      ) : !open.length ? (
        <Empty>
          No appraisal round is running. That is different from having no review —
          when HR opens one it will appear here.
        </Empty>
      ) : cycleId ? (
        <SelfReview cycleId={cycleId} cycle={open.find((c) => c.id === cycleId)!} />
      ) : null}
    </div>
  )
}

function SelfReview({ cycleId, cycle }: { cycleId: string; cycle: ReviewCycle }) {
  const reviewQ = useQuery<PerformanceReview | null>(`perf-mine-${cycleId}`, () =>
    api.get<PerformanceReview | null>(`/performance/cycles/${cycleId}/mine`),
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ratings, setRatings] = useState<Record<string, number | null>>({})
  const [comments, setComments] = useState<Record<string, string>>({})
  const [overall, setOverall] = useState('')

  const review = reviewQ.data
  const editable = review?.status === 'draft' || review?.status === 'returned'

  useEffect(() => {
    if (!review) return
    setRatings(Object.fromEntries(review.goals.map((g) => [g.id, g.self_rating])))
    setComments(Object.fromEntries(
      review.goals.map((g) => [g.id, g.self_comment ?? '']),
    ))
    setOverall(review.self_comment ?? '')
  }, [review])

  if (reviewQ.loading) return <Loading />
  if (reviewQ.error) return <ErrorNote>{reviewQ.error}</ErrorNote>
  if (!review) {
    return (
      <Empty>
        This round has not opened your review yet. HR creates them in a batch;
        it will appear here when they do.
      </Empty>
    )
  }

  const totalWeight = review.goals.reduce((sum, g) => sum + g.weight_bps, 0)
  const unrated = review.goals.filter((g) => ratings[g.id] === null).length

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      reviewQ.reload()
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const save = () =>
    act(() =>
      api.post(`/performance/reviews/${review.id}/self`, {
        goals: review.goals.map((g) => ({
          goal_id: g.id,
          rating: ratings[g.id] ?? null,
          comment: comments[g.id] || null,
        })),
        comment: overall || null,
      }),
    )

  return (
    <>
      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="pf-status">
        <span className={`pf-pill pf-${review.status}`}>
          {STATUS_LABEL[review.status] ?? review.status}
        </span>
        {review.status === 'returned' && review.review_note && (
          <span className="muted">
            Sent back: <strong>{review.review_note}</strong>
          </span>
        )}
        {review.manager_name && (
          <span className="muted">Manager: {review.manager_name}</span>
        )}
      </div>

      {/* On screen while the goals are being rated, not at the submit button:
          the server refuses a set that does not come to 100%, and finding that
          out at the end is finding out too late. */}
      {cycle.weights_must_total && totalWeight !== 10000 && (
        <ErrorNote>
          These goals are weighted {weight(totalWeight)} in total and must come
          to 100%. Ask HR to fix the weights — you cannot submit until they do.
        </ErrorNote>
      )}

      {!review.goals.length ? (
        <Empty>No goals have been set for you in this round yet.</Empty>
      ) : (
        <div className="pf-goals">
          {review.goals.map((goal) => (
            <section className="card pf-goal" key={goal.id}>
              <div className="pf-goal-head">
                <div>
                  <div className="pf-goal-title">{goal.title}</div>
                  {goal.description && (
                    <p className="muted">{goal.description}</p>
                  )}
                  {goal.target && (
                    <p className="pf-target"><strong>Target:</strong> {goal.target}</p>
                  )}
                </div>
                <span className="pf-weight">{weight(goal.weight_bps)}</span>
              </div>

              <RatingPicker
                value={ratings[goal.id] ?? null}
                max={cycle.rating_max}
                labels={cycle.rating_labels}
                disabled={!editable}
                onPick={(value) =>
                  setRatings((prev) => ({ ...prev, [goal.id]: value }))
                }
              />
              <textarea
                rows={2}
                disabled={!editable}
                placeholder="What happened, in your words"
                value={comments[goal.id] ?? ''}
                onChange={(e) =>
                  setComments((prev) => ({ ...prev, [goal.id]: e.target.value }))
                }
              />

              {/* Only ever populated once the rating has been shared — the
                  server removes it otherwise, so there is nothing to hide. */}
              {goal.manager_rating !== null && (
                <div className="pf-manager-view">
                  <strong>Manager: {goal.manager_rating}</strong>
                  {goal.manager_comment && <span> — {goal.manager_comment}</span>}
                </div>
              )}
            </section>
          ))}
        </div>
      )}

      <section className="card">
        <h2 className="card-title">Anything else</h2>
        <textarea
          rows={4}
          disabled={!editable}
          placeholder="The year in your own words"
          value={overall}
          onChange={(e) => setOverall(e.target.value)}
        />
      </section>

      {editable && (
        <div className="pf-actions">
          <button className="btn" disabled={busy} onClick={save}>Save</button>
          <button
            className="btn primary"
            disabled={busy || unrated > 0}
            onClick={() =>
              act(async () => {
                await api.post(`/performance/reviews/${review.id}/self`, {
                  goals: review.goals.map((g) => ({
                    goal_id: g.id,
                    rating: ratings[g.id] ?? null,
                    comment: comments[g.id] || null,
                  })),
                  comment: overall || null,
                })
                await api.post(`/performance/reviews/${review.id}/self/submit`, {})
              })
            }
          >
            Submit to my manager
          </button>
          <span className="muted">
            {unrated > 0
              ? `${unrated} goal${unrated === 1 ? '' : 's'} still unrated.`
              : 'Submitting is one-way — you cannot edit afterwards.'}
          </span>
        </div>
      )}

      {review.status === 'finalised' && (
        <section className="card pf-outcome">
          <h2 className="card-title">Outcome</h2>
          {review.rating_visible ? (
            <>
              <div className="pf-final">
                <span className="pf-final-value">{review.overall_rating}</span>
                <span className="muted">
                  of {review.rating_max ?? cycle.rating_max}
                  {ratingLabel(review.overall_rating, cycle.rating_labels)
                    ? ` — ${ratingLabel(review.overall_rating, cycle.rating_labels)}`
                    : ''}
                </span>
              </div>
              <p className="muted">
                Weighted score across your goals: {rating(review.score_centi)}.
              </p>
              {review.final_comment && <p>{review.final_comment}</p>}
            </>
          ) : (
            /* A blank panel after a finalised review reads as a bug, so it says
               why it is blank. */
            <p className="muted">
              Your review is complete. The rating has not been released yet —
              HR shares them once the round is finished.
            </p>
          )}
        </section>
      )}
    </>
  )
}

export const STATUS_LABEL: Record<string, string> = {
  draft: 'Not started',
  self_submitted: 'With your manager',
  manager_submitted: 'With HR',
  returned: 'Sent back to you',
  finalised: 'Complete',
}
