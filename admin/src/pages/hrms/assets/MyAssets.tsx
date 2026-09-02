import '../../../styles/assets.css'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { dateTime } from '../../../lib/format'
import { EmptyState, ErrorNote, Loading } from '../../../components/ui'
import { IconCard } from '../../../components/Icons'
import { CATEGORY_LABEL, errorText } from './Assets'

/**
 * One row of `GET /assets/my`.
 *
 * Mirrors `MyAssetOut`, which is a deliberately smaller shape than the admin
 * register row. It has no `purchase_date` — what the company paid for a laptop
 * is procurement's business — and no return-condition note, because that note
 * is written *about* the holder rather than for them. Neither field is fetched
 * from anywhere else on this page to make up the difference.
 */
interface MyAsset {
  assignment_id: string
  asset_id: string
  asset_tag: string
  category: string
  serial_number: string | null
  assigned_at: string
  /** Shown on purpose: it is what the holder will be asked about at return. */
  assigned_condition_note: string | null
}

export default function MyAssets() {
  /* No permission gate. This endpoint always answers for the caller and takes
     no user id at all, so there is nobody else's list to reach. */
  const assets = useQuery<MyAsset[]>('my-assets', () => api.get<MyAsset[]>('/assets/my'))

  if (assets.error) {
    return <ErrorNote>{errorText(assets.error, 'Could not load your assets')}</ErrorNote>
  }
  if (assets.loading) return <Loading />

  const rows = assets.data ?? []

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">My assets</h1>
          <p className="page-sub">
            Company property currently issued to you.
          </p>
        </div>
      </div>

      {rows.length === 0 ? (
        <section className="card">
          <EmptyState
            icon={<IconCard size={22} />}
            title="Nothing is issued to you"
            body="When IT hands you a laptop, monitor, SIM or ID card and records it, it appears here with the condition it was handed over in."
          />
        </section>
      ) : (
        <div className="as-my-grid" style={{ opacity: assets.refetching ? 0.6 : 1 }}>
          {rows.map((row) => (
            <article className="as-my-card" key={row.assignment_id}>
              <div className="as-my-head">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="as-tag">{row.asset_tag}</div>
                  <div className="as-cat">{CATEGORY_LABEL[row.category] ?? row.category}</div>
                </div>
                <span className="as-pill as-assigned">
                  <span className="as-pill-dot" style={{ background: 'currentColor' }} />
                  With you
                </span>
              </div>

              <div className="as-my-meta">
                <div className="as-my-row">
                  <span>Issued</span>
                  <b>{dateTime(row.assigned_at)}</b>
                </div>
                {row.serial_number && (
                  <div className="as-my-row">
                    <span>Serial</span>
                    <b className="as-serial">{row.serial_number}</b>
                  </div>
                )}
              </div>

              {row.assigned_condition_note && (
                <div className="as-note" style={{ marginTop: 12 }}>
                  <span className="as-note-label">Condition when you received it</span>
                  {row.assigned_condition_note}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
