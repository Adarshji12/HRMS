/* The shape of a configurable list column for the ERP screens, and the two
 * helpers that draw a row's headings and cells from the visible columns.
 * See components/ViewSettings for the picker itself. */

import type { CSSProperties, ReactNode } from 'react'
import type { ColumnDef } from '../../components/ViewSettings'

/** A column of a list: how it is headed and how a row fills it. `ctx` carries
 *  whatever row-level handlers a cell needs. */
export type Col<R, C = undefined> = ColumnDef & {
  td: (row: R, ctx: C) => ReactNode
  className?: string | ((row: R) => string)
  title?: (row: R) => string | undefined
  style?: (row: R) => CSSProperties | undefined
  thClass?: string
  thStyle?: CSSProperties
}

export function heads<R, C = undefined>(cols: ColumnDef[]) {
  return (cols as Array<Col<R, C>>).map((c) => (
    <th key={c.key} className={c.thClass} style={c.thStyle}>{c.label}</th>
  ))
}

export function cells<R, C = undefined>(cols: ColumnDef[], row: R, ctx?: C) {
  return (cols as Array<Col<R, C>>).map((c) => (
    <td key={c.key} className={typeof c.className === 'function' ? c.className(row) : c.className}
      title={c.title?.(row)} style={c.style?.(row)}>{c.td(row, ctx as C)}</td>
  ))
}
