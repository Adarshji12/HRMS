/** "Not sure of the layout? Download the template" — an example file for an import, under the file chooser. */

import { downloadCsv, type Cell } from '../lib/sheet'

export default function SampleFile({ filename, headers, rows }: { filename: string; headers: string[]; rows: Cell[][] }) {
  return (
    <p className="muted-sm" style={{ margin: '8px 0 0' }}>
      Not sure of the layout?{' '}
      <button type="button" className="vw-link" onClick={() => downloadCsv(filename, headers, rows)}>Download the template</button>
    </p>
  )
}
