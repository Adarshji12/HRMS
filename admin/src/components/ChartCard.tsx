import { useState, type ReactNode } from 'react'

export interface LegendEntry {
  label: string
  color: string
}

interface Props {
  title: string
  note?: string
  legend?: LegendEntry[]
  /** The WCAG-clean twin. Every chart has one — tooltips enhance, never gate. */
  table?: ReactNode
  children: ReactNode
}

export function ChartCard({ title, note, legend, table, children }: Props) {
  const [showTable, setShowTable] = useState(false)

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{title}</h2>
        <div className="card-tools">
          {note && <span className="card-note">{note}</span>}
          {/* Two named choices, not one button whose label is the state you are
              NOT in — "Table" on a chart never said whether it was describing
              what you are looking at or what you would get by pressing it. */}
          {table && (
            <div className="ts-toggle ts-toggle-xs" role="group" aria-label="Chart or table">
              {([false, true] as const).map((asTable) => (
                <button
                  key={String(asTable)}
                  className={`ts-toggle-btn ${showTable === asTable ? 'ts-toggle-on' : ''}`}
                  onClick={() => setShowTable(asTable)}
                  aria-pressed={showTable === asTable}
                >
                  {asTable ? 'Table' : 'Chart'}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {showTable && table ? (
        <div className="table-wrap">{table}</div>
      ) : (
        <>
          {children}
          {legend && legend.length >= 2 && (
            <div className="legend" style={{ marginTop: 12 }}>
              {legend.map((entry) => (
                <span className="legend-item" key={entry.label}>
                  <span className="legend-swatch" style={{ background: entry.color }} />
                  {entry.label}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}
