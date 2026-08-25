import { useState } from 'react'
import '../../../styles/onboarding.css'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { useAuth } from '../../../lib/auth'
import { shortDate } from '../../../lib/format'
import { Empty, EmptyState, ErrorNote, Loading, Meter } from '../../../components/ui'
import { IconCheck, IconSheet } from '../../../components/Icons'
import {
  CATEGORY_LABEL,
  OWNER_ROLE_LABEL,
  TaskRow,
  UploadForm,
  closedIn,
  errorText,
  fileSize,
  progressOf,
  type OnbDocument,
  type OnbInstanceDetail,
  type OnbTask,
} from './Onboarding'

/**
 * The new hire's own checklist.
 *
 * Gated on nothing but being signed in — `GET /onboarding/my` always answers
 * for the caller and takes no user id, so there is nobody else's checklist to
 * reach from here.
 *
 * The endpoint returns `null`, not a 404, when the caller is not being
 * onboarded. That is the ordinary state for almost everybody in the company,
 * and a page that treats the normal case as an error renders an error for the
 * normal case.
 */
export default function MyOnboarding() {
  const { user } = useAuth()
  const mine = useQuery<OnbInstanceDetail | null>('my-onboarding', () =>
    api.get<OnbInstanceDetail | null>('/onboarding/my'),
  )
  const [error, setError] = useState<string | null>(null)
  const [uploadFor, setUploadFor] = useState<OnbTask | null>(null)

  if (mine.error) {
    return <ErrorNote>{errorText(mine.error, 'Could not load your checklist')}</ErrorNote>
  }
  if (mine.loading) return <Loading />

  const d = mine.data ?? null

  if (!d) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1 className="page-title">My onboarding</h1>
          </div>
        </div>
        <section className="card">
          <EmptyState
            icon={<IconSheet size={22} />}
            title="You have no onboarding checklist"
            body="Nothing is wrong — this page only has something on it while you are being onboarded. If you have just joined and expected a checklist here, ask HR to start one."
          />
        </section>
      </div>
    )
  }

  const pct = progressOf(d)
  const skipped = d.closed_tasks - d.completed_tasks
  const finished = d.status === 'completed' || d.status === 'cancelled'

  /** Documents already attached to a task, so a row can show its own evidence
   *  without the reader hunting the list at the bottom of the page. */
  function docsFor(taskId: string): OnbDocument[] {
    return d!.documents.filter((doc) => doc.task_id === taskId)
  }

  /** Whose task this is. The server allows the hire to move their own items
   *  only — a task owned by HR or IT is somebody else's sign-off and stays
   *  that way even on the hire's own checklist. A named assignee may act
   *  regardless of owner role. */
  function canAct(task: OnbTask): boolean {
    if (finished) return false
    if (task.assignee_user_id && task.assignee_user_id === user?.id) return true
    return task.owner_role === 'employee'
  }

  function reload() {
    setError(null)
    mine.reload()
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">My onboarding</h1>
          <p className="page-sub">
            Everything that has to happen for you to be fully set up. Tick off your own steps as
            you finish them; the ones HR, IT or your manager owe you are shown so you can see
            where things stand, not so you can close them.
          </p>
        </div>
      </div>

      <div className="ob-my-head">
        <div className="ob-my-top">
          <div className="ob-my-date">
            Joining day <b>{shortDate(d.joining_date)}</b>
            {d.manager_name ? (
              <>
                {' '}· reporting to <b>{d.manager_name}</b>
              </>
            ) : null}
          </div>
          <div className="ob-progress-pct" style={{ fontSize: 15 }}>
            {pct}%
          </div>
        </div>
        <div className="ob-my-bar">
          <Meter value={d.closed_tasks} max={d.total_tasks} />
        </div>
        <div className="ob-my-caption">
          <span>
            {d.completed_tasks} done
            {skipped > 0 ? `, ${skipped} not applicable` : ''} of {d.total_tasks}
          </span>
          {d.overdue_tasks > 0 && <span className="ob-overdue">{d.overdue_tasks} overdue</span>}
        </div>
      </div>

      {finished && (
        <div className="ob-note" style={{ marginBottom: 14 }}>
          <b>
            {d.status === 'completed' ? 'Your onboarding is complete.' : 'This checklist was cancelled.'}
          </b>{' '}
          It stays here as a record of what was done.
        </div>
      )}

      {error && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {d.groups.length === 0 ? (
        <section className="card">
          <EmptyState
            icon={<IconSheet size={22} />}
            title="Your checklist has no steps yet"
            body="HR has started onboarding for you but has not added any tasks. They will appear here as soon as they do."
          />
        </section>
      ) : (
        <div className="ob-groups">
          {d.groups.map((group) => {
            const closed = closedIn(group.tasks)
            return (
              <div className="ob-group" key={group.category}>
                <div className="ob-group-head">
                  <div className="ob-group-name">
                    {CATEGORY_LABEL[group.category] ?? group.category}
                  </div>
                  <span className="ob-group-counts">
                    {closed} of {group.total} done
                    {group.overdue > 0 ? ` · ${group.overdue} overdue` : ''}
                  </span>
                </div>

                {group.tasks.length === 0 ? (
                  <Empty>Nothing in this section.</Empty>
                ) : (
                  group.tasks.map((task) => {
                    const mineToDo = canAct(task)
                    const attached = docsFor(task.id)
                    return (
                      <TaskRow
                        key={task.id}
                        task={task}
                        readOnly={finished}
                        canAct={mineToDo}
                        waitingLabel={`waiting on ${OWNER_ROLE_LABEL[task.owner_role] ?? task.owner_role}`}
                        onError={setError}
                        onChanged={reload}
                        extra={
                          <>
                            {attached.length > 0 && (
                              <div className="ob-task-meta">
                                {attached.map((doc) => (
                                  <span key={doc.id} className="ob-tag">
                                    <IconCheck size={10} /> {doc.file_name} ·{' '}
                                    {fileSize(doc.file_size)} ·{' '}
                                    {doc.is_verified ? 'verified' : 'awaiting verification'}
                                  </span>
                                ))}
                              </div>
                            )}

                            {task.requires_document && mineToDo && (
                              uploadFor?.id === task.id ? (
                                <UploadForm
                                  instanceId={d.id}
                                  tasks={[task]}
                                  defaultTaskId={task.id}
                                  onCancel={() => setUploadFor(null)}
                                  onDone={() => {
                                    setUploadFor(null)
                                    reload()
                                  }}
                                />
                              ) : (
                                <div style={{ marginTop: 8 }}>
                                  <button
                                    className="btn btn-sm"
                                    onClick={() => setUploadFor(task)}
                                  >
                                    Upload {task.doc_type ?? 'the document'}
                                  </button>
                                  <span className="ob-waiting" style={{ marginLeft: 8 }}>
                                    this step cannot be ticked off until a file is attached
                                  </span>
                                </div>
                              )
                            )}
                          </>
                        }
                      />
                    )
                  })
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Files not tied to a task still belong to the hire, so they are listed
          rather than hidden. Downloads are not offered here: reading a stored
          document is the permission-checked endpoint's business, and the hire
          already has the file they uploaded. */}
      {d.documents.filter((doc) => !doc.task_id).length > 0 && (
        <section className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <h2 className="card-title">Other documents you have sent</h2>
          </div>
          <div className="ob-docs">
            {d.documents
              .filter((doc) => !doc.task_id)
              .map((doc) => (
                <div className="ob-doc" key={doc.id}>
                  <div className="ob-doc-body">
                    <div className="ob-doc-name">{doc.file_name}</div>
                    <div className="ob-doc-meta">
                      {doc.doc_type} · {fileSize(doc.file_size)}
                    </div>
                  </div>
                  <span className={`ob-pill ${doc.is_verified ? 'ob-verified' : 'ob-unverified'}`}>
                    <span className="ob-pill-dot" style={{ background: 'currentColor' }} />
                    {doc.is_verified ? 'Verified' : 'Awaiting verification'}
                  </span>
                </div>
              ))}
          </div>
        </section>
      )}
    </div>
  )
}
