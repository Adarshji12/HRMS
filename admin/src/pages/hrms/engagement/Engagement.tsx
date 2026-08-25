/* The employee's side of engagement: what the company has said, what it is
 * asking, and who has thanked whom.
 *
 * Three things this page is careful about.
 *
 * **It tells the truth about anonymity, in the place where somebody decides
 * whether to answer honestly.** The banner above an anonymous survey says what
 * the guarantee actually is — no identity is stored with the answer, and
 * results are withheld below a threshold — rather than the word "anonymous",
 * which everyone has learned to disbelieve.
 *
 * **Reading and acknowledging are separate buttons**, because they are separate
 * facts on the server. A single "Got it" that quietly did both would make the
 * acknowledgement worthless as evidence.
 *
 * **A submitted survey cannot be reopened here**, and the page says so before
 * the submit rather than after: an anonymous answer has nothing on it that
 * could identify which one was yours, so there is nothing to go back and edit.
 */

import { useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { dateTime, shortDate } from '../../../lib/format'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type {
  AnnouncementPost,
  PulseSurvey,
  RecognitionPost,
} from '../../../lib/types'
import './engagement.css'

export default function Engagement() {
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Noticeboard</h1>
          <p className="muted">
            What the company has announced, what it is asking, and what your
            colleagues have said about each other.
          </p>
        </div>
      </header>
      {error && <ErrorNote>{error}</ErrorNote>}
      <MySurveys onError={setError} />
      <Feed onError={setError} />
      <Wall onError={setError} />
    </div>
  )
}

/* --------------------------------------------------------------- surveys --- */

function MySurveys({ onError }: { onError: (m: string | null) => void }) {
  const listQ = useQuery<PulseSurvey[]>('eng-my-surveys', () =>
    api.get<PulseSurvey[]>('/engagement/surveys/mine'),
  )
  const [open, setOpen] = useState<string | null>(null)

  const waiting = (listQ.data ?? []).filter((s) => !s.i_responded)
  if (!listQ.data?.length) return null

  return (
    <section className="card">
      <h2 className="card-title">Surveys</h2>
      {!waiting.length ? (
        <p className="muted">
          You have answered everything open. Thank you.
        </p>
      ) : (
        waiting.map((survey) => (
          <div className="eg-survey" key={survey.id}>
            <div className="eg-survey-head">
              <div>
                <div className="eg-title">{survey.title}</div>
                {survey.description && <p className="muted">{survey.description}</p>}
              </div>
              <button className="btn primary"
                      onClick={() => setOpen(open === survey.id ? null : survey.id)}>
                {open === survey.id ? 'Close' : 'Answer'}
              </button>
            </div>

            {/* The guarantee, stated where somebody decides whether to answer
                honestly — not the word "anonymous", which everyone has learned
                to disbelieve. */}
            <div className={`eg-privacy${survey.is_anonymous ? '' : ' is-named'}`}>
              {survey.is_anonymous ? (
                <>
                  <strong>Anonymous.</strong> Your answers are stored with no
                  record of who gave them — not hidden, not stored. Nobody can
                  see how you answered, including an administrator. Results are
                  withheld entirely until at least {survey.min_responses} people
                  have replied.
                </>
              ) : (
                <>
                  <strong>Your name is recorded</strong> with these answers and
                  whoever runs this survey can see it.
                </>
              )}
            </div>

            {open === survey.id && (
              <SurveyForm
                survey={survey}
                onDone={() => { setOpen(null); listQ.reload() }}
                onError={onError}
              />
            )}
          </div>
        ))
      )}
    </section>
  )
}

function SurveyForm({
  survey,
  onDone,
  onError,
}: {
  survey: PulseSurvey
  onDone: () => void
  onError: (m: string | null) => void
}) {
  const [answers, setAnswers] = useState<Record<string, { rating?: number; text?: string; choice?: string }>>({})
  const [busy, setBusy] = useState(false)

  const missing = survey.questions.filter(
    (q) => q.is_required && !answers[q.id]?.rating
      && !answers[q.id]?.text && !answers[q.id]?.choice,
  )

  return (
    <div className="eg-form">
      {survey.questions.map((question) => (
        <div className="eg-question" key={question.id}>
          <div className="eg-prompt">
            {question.prompt}
            {!question.is_required && <span className="muted"> (optional)</span>}
          </div>

          {question.kind === 'scale' && (
            <div className="eg-scale">
              {Array.from({ length: question.scale_max }, (_, i) => i + 1).map((point) => (
                <button
                  key={point}
                  type="button"
                  className={`eg-point${answers[question.id]?.rating === point ? ' is-on' : ''}`}
                  onClick={() =>
                    setAnswers((prev) => ({
                      ...prev,
                      [question.id]: {
                        ...prev[question.id],
                        rating: prev[question.id]?.rating === point ? undefined : point,
                      },
                    }))
                  }
                >
                  {point}
                </button>
              ))}
            </div>
          )}

          {question.kind === 'choice' && (
            <div className="eg-choices">
              {(question.choices ?? []).map((choice) => (
                <label key={choice} className="eg-choice">
                  <input
                    type="radio"
                    name={question.id}
                    checked={answers[question.id]?.choice === choice}
                    onChange={() =>
                      setAnswers((prev) => ({
                        ...prev,
                        [question.id]: { ...prev[question.id], choice },
                      }))
                    }
                  />
                  <span>{choice}</span>
                </label>
              ))}
            </div>
          )}

          {question.kind === 'text' && (
            <textarea
              rows={3}
              value={answers[question.id]?.text ?? ''}
              onChange={(e) =>
                setAnswers((prev) => ({
                  ...prev,
                  [question.id]: { ...prev[question.id], text: e.target.value },
                }))
              }
            />
          )}
        </div>
      ))}

      <div className="eg-actions">
        <button
          className="btn primary"
          disabled={busy || missing.length > 0}
          onClick={async () => {
            setBusy(true)
            onError(null)
            try {
              await api.post(`/engagement/surveys/${survey.id}/submit`, {
                answers: survey.questions
                  .filter((q) => answers[q.id])
                  .map((q) => ({
                    question_id: q.id,
                    rating: answers[q.id]?.rating ?? null,
                    text: answers[q.id]?.text || null,
                    choice: answers[q.id]?.choice ?? null,
                  })),
              })
              onDone()
            } catch (caught) {
              onError((caught as Error).message)
            } finally {
              setBusy(false)
            }
          }}
        >
          Submit
        </button>
        <span className="muted">
          {missing.length
            ? `${missing.length} required question${missing.length === 1 ? '' : 's'} left.`
            : survey.is_anonymous
              ? 'Once submitted this cannot be changed — an anonymous answer has nothing on it that could identify which one was yours.'
              : 'Once submitted this cannot be changed.'}
        </span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ feed --- */

function Feed({ onError }: { onError: (m: string | null) => void }) {
  const feedQ = useQuery<AnnouncementPost[]>('eng-feed', () =>
    api.get<AnnouncementPost[]>('/engagement/announcements'),
  )
  const [busy, setBusy] = useState(false)

  async function mark(post: AnnouncementPost, acknowledge: boolean) {
    setBusy(true)
    onError(null)
    try {
      await api.post(`/engagement/announcements/${post.id}/read`, { acknowledge })
      feedQ.reload()
    } catch (caught) {
      onError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2 className="card-title">Announcements</h2>
      {feedQ.loading ? (
        <Loading />
      ) : feedQ.error ? (
        <ErrorNote>{feedQ.error}</ErrorNote>
      ) : !feedQ.data?.length ? (
        <Empty>Nothing announced. That is a good sign, mostly.</Empty>
      ) : (
        feedQ.data.map((post) => (
          <article className={`eg-post${post.is_pinned ? ' is-pinned' : ''}`} key={post.id}>
            <div className="eg-post-head">
              <div className="eg-title">
                {post.is_pinned && <span className="eg-pin">Pinned</span>}
                {post.title}
              </div>
              <span className="muted">
                {post.published_at ? shortDate(post.published_at) : ''}
                {post.published_by_name ? ` · ${post.published_by_name}` : ''}
              </span>
            </div>
            <div className="eg-body">{post.body}</div>

            <div className="eg-post-foot">
              {post.requires_acknowledgement ? (
                post.acknowledged_at ? (
                  <span className="eg-done">
                    Acknowledged {dateTime(post.acknowledged_at)}
                  </span>
                ) : (
                  <>
                    <button className="btn small primary" disabled={busy}
                            onClick={() => mark(post, true)}>
                      I have read and accept this
                    </button>
                    <span className="muted">
                      This one needs your acknowledgement, not just a read.
                    </span>
                  </>
                )
              ) : post.read_at ? (
                <span className="eg-done">Read</span>
              ) : (
                <button className="btn small" disabled={busy}
                        onClick={() => mark(post, false)}>
                  Mark as read
                </button>
              )}
            </div>
          </article>
        ))
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ wall --- */

function Wall({ onError }: { onError: (m: string | null) => void }) {
  const wallQ = useQuery<RecognitionPost[]>('eng-wall', () =>
    api.get<RecognitionPost[]>('/engagement/recognition'),
  )
  const [writing, setWriting] = useState(false)

  return (
    <section className="card">
      <div className="eg-survey-head">
        <h2 className="card-title">Recognition</h2>
        <button className="btn small" onClick={() => setWriting((v) => !v)}>
          {writing ? 'Cancel' : 'Thank a colleague'}
        </button>
      </div>

      {writing && (
        <GiveRecognition
          onDone={() => { setWriting(false); wallQ.reload() }}
          onError={onError}
        />
      )}

      {wallQ.loading ? (
        <Loading />
      ) : !wallQ.data?.length ? (
        <Empty>Nothing yet. Somebody has to go first.</Empty>
      ) : (
        <ul className="eg-wall">
          {wallQ.data.map((row) => (
            <li key={row.id}>
              <div>
                {/* A name that resolves to nothing means the person has left.
                    "A former colleague" is truer than a blank. */}
                <strong>{row.from_name ?? 'A former colleague'}</strong> thanked{' '}
                <strong>{row.to_name ?? 'a former colleague'}</strong>
                {row.competency_name && (
                  <span className="eg-tag">{row.competency_name}</span>
                )}
                {!row.is_public && <span className="eg-tag is-private">Private</span>}
              </div>
              <p>{row.message}</p>
              <span className="muted">{shortDate(row.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function GiveRecognition({
  onDone,
  onError,
}: {
  onDone: () => void
  onError: (m: string | null) => void
}) {
  const peopleQ = useQuery<Array<{ user_id: string; full_name: string }>>(
    'eng-directory', () => api.get('/people/directory'),
  )
  const [to, setTo] = useState('')
  const [message, setMessage] = useState('')
  const [isPublic, setIsPublic] = useState(true)
  const [busy, setBusy] = useState(false)

  return (
    <div className="eg-form">
      <div className="eg-row">
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Who?</option>
          {(peopleQ.data ?? []).map((p) => (
            <option key={p.user_id} value={p.user_id}>{p.full_name}</option>
          ))}
        </select>
      </div>
      <textarea rows={3} value={message} placeholder="What did they do?"
                onChange={(e) => setMessage(e.target.value)} />
      <label className="eg-check">
        <input type="checkbox" checked={isPublic}
               onChange={(e) => setIsPublic(e.target.checked)} />
        <span>
          Show it on the wall. Unticked keeps it between the two of you —
          administrators cannot read it either.
        </span>
      </label>
      <div className="eg-actions">
        <button className="btn primary" disabled={busy || !to || !message.trim()}
                onClick={async () => {
                  setBusy(true)
                  onError(null)
                  try {
                    await api.post('/engagement/recognition', {
                      to_user_id: to, message: message.trim(), is_public: isPublic,
                    })
                    onDone()
                  } catch (caught) {
                    onError((caught as Error).message)
                  } finally {
                    setBusy(false)
                  }
                }}>
          Send
        </button>
      </div>
    </div>
  )
}
