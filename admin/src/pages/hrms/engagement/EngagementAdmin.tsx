/* Publishing announcements and running pulse surveys.
 *
 * The interesting screen here is the results one, and what it is careful about
 * is saying *why* it is not showing something.
 *
 * A results page that renders an empty chart when too few people have answered
 * looks broken, and somebody will file a bug or — worse — assume nobody
 * responded. So a withheld result says the threshold, the count, and the
 * reason, in the space the numbers would have occupied. The same applies per
 * question: a free-text question held back while the ratings show is not a
 * failure, it is the rule working, and the screen says so.
 *
 * The other thing worth noting is what this page cannot do. There is no control
 * anywhere on it that reveals who answered how, because the server has no
 * endpoint behind one and no column to build one from. "Who has not answered"
 * is a different question with its own endpoint, and it reads a different
 * table.
 */

import { useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { shortDate } from '../../../lib/format'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type {
  AnnouncementPost,
  AnnouncementReach,
  PulseSurvey,
  SurveyResults,
} from '../../../lib/types'
import './engagement.css'

/** Hundredths as a rating. 370 → "3.70". */
function mean(centi: number | null): string {
  return centi === null ? '—' : (centi / 100).toFixed(2)
}

export default function EngagementAdmin() {
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'posts' | 'surveys'>('posts')

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Communication</h1>
          <p className="muted">
            Announce things, and ask people how it is going.
          </p>
        </div>
        <div className="eg-tabs">
          <button className={`chip${tab === 'posts' ? ' is-on' : ''}`}
                  onClick={() => setTab('posts')}>Announcements</button>
          <button className={`chip${tab === 'surveys' ? ' is-on' : ''}`}
                  onClick={() => setTab('surveys')}>Surveys</button>
        </div>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}
      {tab === 'posts' ? <Posts onError={setError} /> : <Surveys onError={setError} />}
    </div>
  )
}

/* --------------------------------------------------------- announcements --- */

function Posts({ onError }: { onError: (m: string | null) => void }) {
  const listQ = useQuery<AnnouncementPost[]>('eng-admin-posts', () =>
    api.get<AnnouncementPost[]>('/engagement/announcements/manage'),
  )
  const [writing, setWriting] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    onError(null)
    try {
      await fn()
      listQ.reload()
    } catch (caught) {
      onError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="eg-actions">
        <button className="btn primary" onClick={() => setWriting((v) => !v)}>
          {writing ? 'Close' : 'Write an announcement'}
        </button>
      </div>

      {writing && (
        <NewPost onDone={() => { setWriting(false); listQ.reload() }} onError={onError} />
      )}

      {listQ.loading ? (
        <Loading />
      ) : !listQ.data?.length ? (
        <Empty>Nothing written yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Title</th><th>Audience</th><th>Status</th><th>Published</th><th />
              </tr>
            </thead>
            <tbody>
              {listQ.data.map((post) => (
                <tr key={post.id}>
                  <td>
                    {post.is_pinned && <span className="eg-pin">Pinned</span>}
                    {post.title}
                    {post.requires_acknowledgement && (
                      <span className="eg-tag">Needs acknowledgement</span>
                    )}
                  </td>
                  <td className="muted">{post.audience_kind}</td>
                  <td><span className={`eg-pill eg-${post.status}`}>{post.status}</span></td>
                  <td className="muted">
                    {post.published_at ? shortDate(post.published_at) : '—'}
                  </td>
                  <td className="row-actions">
                    {post.status === 'draft' && (
                      <button className="btn small primary" disabled={busy}
                              onClick={() => act(() =>
                                api.post(`/engagement/announcements/${post.id}/publish`, {}))}>
                        Publish
                      </button>
                    )}
                    {post.status === 'published' && (
                      <>
                        <button className="btn small"
                                onClick={() => setOpen(open === post.id ? null : post.id)}>
                          {open === post.id ? 'Hide' : 'Reach'}
                        </button>
                        <button className="btn small" disabled={busy}
                                onClick={() => act(() =>
                                  api.post(`/engagement/announcements/${post.id}/archive`, {}))}>
                          Archive
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && <ReachPanel postId={open} onError={onError} />}
    </>
  )
}

function ReachPanel({
  postId,
  onError,
}: {
  postId: string
  onError: (m: string | null) => void
}) {
  const reachQ = useQuery<AnnouncementReach>(`eng-reach-${postId}`, () =>
    api.get<AnnouncementReach>(`/engagement/announcements/${postId}/reach`),
  )
  if (reachQ.loading) return <Loading />
  if (reachQ.error) {
    onError(reachQ.error)
    return null
  }
  const reach = reachQ.data
  if (!reach) return null

  return (
    <section className="card">
      <h2 className="card-title">Reach</h2>
      <div className="eg-figures">
        <div><span className="eg-figure">{reach.audience}</span><span className="muted">sent to</span></div>
        <div><span className="eg-figure">{reach.read}</span><span className="muted">read</span></div>
        <div><span className="eg-figure">{reach.acknowledged}</span><span className="muted">acknowledged</span></div>
      </div>
      {reach.outstanding.length ? (
        <>
          <p className="muted">
            Still outstanding — the people who have not done what was asked,
            which is acknowledging where that was required and reading otherwise:
          </p>
          <p>{reach.outstanding.join(', ')}</p>
        </>
      ) : (
        <p className="muted">Everybody is done.</p>
      )}
    </section>
  )
}

function NewPost({
  onDone,
  onError,
}: {
  onDone: () => void
  onError: (m: string | null) => void
}) {
  const [form, setForm] = useState({
    title: '', body: '', is_pinned: false,
    requires_acknowledgement: false, expires_on: '',
  })
  const [busy, setBusy] = useState(false)

  return (
    <section className="card eg-form">
      <h2 className="card-title">New announcement</h2>
      <input value={form.title} placeholder="Title"
             onChange={(e) => setForm({ ...form, title: e.target.value })} />
      <textarea rows={6} value={form.body} placeholder="What are you telling people?"
                onChange={(e) => setForm({ ...form, body: e.target.value })} />
      <label className="eg-check">
        <input type="checkbox" checked={form.is_pinned}
               onChange={(e) => setForm({ ...form, is_pinned: e.target.checked })} />
        <span>Pin it to the top of the feed</span>
      </label>
      <label className="eg-check">
        <input type="checkbox" checked={form.requires_acknowledgement}
               onChange={(e) =>
                 setForm({ ...form, requires_acknowledgement: e.target.checked })} />
        <span>
          Require an acknowledgement. Reading is passive; accepting is an act —
          a policy change needs the second, a canteen notice does not.
        </span>
      </label>
      <label className="eg-field">
        <span className="eg-label">Expires (optional)</span>
        <input type="date" value={form.expires_on}
               onChange={(e) => setForm({ ...form, expires_on: e.target.value })} />
        <span className="muted">
          Blank means it stays until archived — right for a policy, wrong for a
          one-day notice.
        </span>
      </label>
      <div className="eg-actions">
        <button className="btn primary" disabled={busy || !form.title || !form.body}
                onClick={async () => {
                  setBusy(true)
                  onError(null)
                  try {
                    await api.post('/engagement/announcements', {
                      ...form, expires_on: form.expires_on || null,
                    })
                    onDone()
                  } catch (caught) {
                    onError((caught as Error).message)
                  } finally {
                    setBusy(false)
                  }
                }}>
          Save as draft
        </button>
        <span className="muted">Nobody sees it until you publish.</span>
      </div>
    </section>
  )
}

/* ---------------------------------------------------------------- surveys -- */

function Surveys({ onError }: { onError: (m: string | null) => void }) {
  const listQ = useQuery<PulseSurvey[]>('eng-admin-surveys', () =>
    api.get<PulseSurvey[]>('/engagement/surveys'),
  )
  const [writing, setWriting] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    onError(null)
    try {
      await fn()
      listQ.reload()
    } catch (caught) {
      onError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="eg-actions">
        <button className="btn primary" onClick={() => setWriting((v) => !v)}>
          {writing ? 'Close' : 'New survey'}
        </button>
      </div>
      {writing && (
        <NewSurvey onDone={() => { setWriting(false); listQ.reload() }} onError={onError} />
      )}

      {listQ.loading ? (
        <Loading />
      ) : !listQ.data?.length ? (
        <Empty>No surveys yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Survey</th><th>Kind</th><th>Status</th>
                <th className="num">Responses</th><th />
              </tr>
            </thead>
            <tbody>
              {listQ.data.map((survey) => (
                <tr key={survey.id}>
                  <td>{survey.title}</td>
                  <td>
                    {survey.is_anonymous ? (
                      <span className="eg-tag">Anonymous</span>
                    ) : (
                      <span className="eg-tag is-named">Named</span>
                    )}
                  </td>
                  <td>
                    <span className={`eg-pill eg-${survey.status}`}>{survey.status}</span>
                  </td>
                  <td className="num">
                    {survey.responded}/{survey.invited}
                  </td>
                  <td className="row-actions">
                    {survey.status === 'draft' && (
                      <button className="btn small primary" disabled={busy}
                              onClick={() => act(() =>
                                api.post(`/engagement/surveys/${survey.id}/open`, {}))}>
                        Open
                      </button>
                    )}
                    {survey.status !== 'draft' && (
                      <button className="btn small"
                              onClick={() => setOpen(open === survey.id ? null : survey.id)}>
                        {open === survey.id ? 'Hide' : 'Results'}
                      </button>
                    )}
                    {survey.status === 'open' && (
                      <button className="btn small" disabled={busy}
                              onClick={() => act(() =>
                                api.post(`/engagement/surveys/${survey.id}/close`, {}))}>
                        Close
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && <ResultsPanel surveyId={open} onError={onError} />}
    </>
  )
}

function ResultsPanel({
  surveyId,
  onError,
}: {
  surveyId: string
  onError: (m: string | null) => void
}) {
  const resultsQ = useQuery<SurveyResults>(`eng-results-${surveyId}`, () =>
    api.get<SurveyResults>(`/engagement/surveys/${surveyId}/results`),
  )
  const outstandingQ = useQuery<string[]>(`eng-outstanding-${surveyId}`, () =>
    api.get<string[]>(`/engagement/surveys/${surveyId}/outstanding`),
  )

  if (resultsQ.loading) return <Loading />
  if (resultsQ.error) {
    onError(resultsQ.error)
    return null
  }
  const results = resultsQ.data
  if (!results) return null

  return (
    <section className="card">
      <h2 className="card-title">{results.title}</h2>
      <p className="muted">
        {results.responded} of {results.invited} answered
        {results.is_anonymous
          ? ` · anonymous, results withheld below ${results.min_responses}`
          : ' · names recorded'}
      </p>

      {/* Occupies the space the numbers would have, and says why. A results
          page that renders an empty chart looks broken, and somebody will
          conclude nobody responded. */}
      {results.withheld_reason && (
        <div className="eg-withheld">{results.withheld_reason}</div>
      )}

      {results.questions.map((question) => (
        <div className="eg-result" key={question.question_id}>
          <div className="eg-prompt">{question.prompt}</div>

          {question.withheld ? (
            <p className="muted">
              Withheld — too few answers for this to stay anonymous.
              {question.kind === 'text' &&
                ' Written answers need more replies than ratings do: a sentence identifies its author in a way a number does not.'}
            </p>
          ) : question.kind === 'scale' ? (
            <>
              <div className="eg-mean">{mean(question.mean_centi)}</div>
              <div className="eg-dist">
                {question.distribution.map((count, i) => {
                  const total = question.distribution.reduce((a, b) => a + b, 0) || 1
                  return (
                    <div className="eg-bar" key={i}>
                      <div className="eg-bar-fill"
                           style={{ height: `${(count / total) * 100}%` }} />
                      <span>{i + 1}</span>
                    </div>
                  )
                })}
              </div>
            </>
          ) : question.kind === 'choice' ? (
            <ul className="eg-counts">
              {Object.entries(question.counts).map(([choice, count]) => (
                <li key={choice}><span>{choice}</span><strong>{count}</strong></li>
              ))}
            </ul>
          ) : (
            <ul className="eg-texts">
              {question.texts.map((text, i) => <li key={i}>{text}</li>)}
            </ul>
          )}
        </div>
      ))}

      {outstandingQ.data?.length ? (
        <>
          <h3 className="eg-prompt">Not answered yet</h3>
          {/* This list comes from the participation table and only that. It is
              the reason participation is tracked separately from content. */}
          <p className="muted">{outstandingQ.data.join(', ')}</p>
        </>
      ) : null}
    </section>
  )
}

function NewSurvey({
  onDone,
  onError,
}: {
  onDone: () => void
  onError: (m: string | null) => void
}) {
  const [title, setTitle] = useState('')
  const [anonymous, setAnonymous] = useState(true)
  const [minResponses, setMinResponses] = useState(4)
  const [questions, setQuestions] = useState([
    { prompt: '', kind: 'scale', scale_max: 5, is_required: true },
  ])
  const [busy, setBusy] = useState(false)

  return (
    <section className="card eg-form">
      <h2 className="card-title">New survey</h2>
      <input value={title} placeholder="Quarterly pulse"
             onChange={(e) => setTitle(e.target.value)} />

      <label className="eg-check">
        <input type="checkbox" checked={anonymous}
               onChange={(e) => setAnonymous(e.target.checked)} />
        <span>
          Anonymous. Answers are stored with no record of who gave them — not
          hidden, <em>not stored</em>. <strong>This cannot be changed once the
          survey opens</strong>, because flipping it afterwards would expose
          people who answered believing otherwise.
        </span>
      </label>

      {anonymous && (
        <label className="eg-field">
          <span className="eg-label">Withhold results below</span>
          <input type="number" min={2} max={100} value={minResponses}
                 onChange={(e) => setMinResponses(Number(e.target.value))} />
          <span className="muted">
            Nothing is shown until this many people have replied. Written answers
            need {minResponses + 2} — a sentence identifies its author in a way a
            number does not. A survey whose audience is smaller than this figure
            will be refused when you try to open it.
          </span>
        </label>
      )}

      {questions.map((question, index) => (
        <div className="eg-question" key={index}>
          <div className="eg-row">
            <input
              value={question.prompt}
              placeholder="Question"
              onChange={(e) => setQuestions(
                questions.map((q, i) => i === index ? { ...q, prompt: e.target.value } : q))}
            />
            <select
              value={question.kind}
              onChange={(e) => setQuestions(
                questions.map((q, i) => i === index ? { ...q, kind: e.target.value } : q))}
            >
              <option value="scale">Rating</option>
              <option value="text">Written</option>
            </select>
          </div>
        </div>
      ))}

      <div className="eg-actions">
        <button className="btn small"
                onClick={() => setQuestions([
                  ...questions,
                  { prompt: '', kind: 'scale', scale_max: 5, is_required: true },
                ])}>
          Add question
        </button>
        <button
          className="btn primary"
          disabled={busy || !title.trim() || questions.some((q) => !q.prompt.trim())}
          onClick={async () => {
            setBusy(true)
            onError(null)
            try {
              await api.post('/engagement/surveys', {
                title: title.trim(),
                is_anonymous: anonymous,
                min_responses: minResponses,
                questions,
              })
              onDone()
            } catch (caught) {
              onError((caught as Error).message)
            } finally {
              setBusy(false)
            }
          }}
        >
          Save as draft
        </button>
      </div>
    </section>
  )
}
