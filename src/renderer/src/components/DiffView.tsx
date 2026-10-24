import { useMemo, type ReactNode } from 'react'
import type { FileDiff } from '@shared/types'
import { cn } from '../lib/utils'

interface Row {
  type: 'hunk' | 'add' | 'del' | 'ctx'
  text: string
  oldNo?: number
  newNo?: number
}

function parse(patch: string): Row[] {
  const rows: Row[] = []
  let oldNo = 0
  let newNo = 0
  let first = true
  for (const line of patch.split('\n')) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      if (!first) rows.push({ type: 'hunk', text: '' })
      first = false
      continue
    }
    first = false
    if (line.startsWith('+')) rows.push({ type: 'add', text: line.slice(1), newNo: newNo++ })
    else if (line.startsWith('-')) rows.push({ type: 'del', text: line.slice(1), oldNo: oldNo++ })
    else rows.push({ type: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, oldNo: oldNo++, newNo: newNo++ })
  }
  return rows
}

export function DiffStat({ added, removed, className }: { added: number; removed: number; className?: string }): ReactNode {
  if (!added && !removed) return null
  return (
    <span className={cn('inline-flex shrink-0 gap-1.5 font-mono text-[11.5px] tabular-nums', className)}>
      {added > 0 && <span className="text-ok">+{added}</span>}
      {removed > 0 && <span className="text-danger">-{removed}</span>}
    </span>
  )
}

export function DiffView({ diff, maxHeight = 420, monochrome = false }: { diff: FileDiff; maxHeight?: number | null; monochrome?: boolean }): ReactNode {
  const rows = useMemo(() => parse(diff.patch), [diff.patch])
  if (rows.length === 0) return <div className="px-3 py-2 text-[12px] text-subtle">No textual changes.</div>
  const width = String(Math.max(...rows.map((r) => r.newNo ?? r.oldNo ?? 0))).length
  return (
    <div className={cn('selectable font-mono text-[12px] leading-[1.55]', maxHeight === null ? 'overflow-visible' : 'overflow-auto')} style={{ maxHeight: maxHeight ?? undefined }}>
      <div className="min-w-max">
        {rows.map((row, index) =>
          row.type === 'hunk' ? (
            <div key={index} className="my-0.5 border-t border-dashed border-line" />
          ) : (
            <div
              key={index}
              className="flex"
              style={{ background: monochrome ? undefined : row.type === 'add' ? 'var(--diff-add)' : row.type === 'del' ? 'var(--diff-del)' : undefined }}
            >
              <span
                className="shrink-0 select-none px-2 text-right text-subtle"
                style={{
                  width: `${width + 2}ch`,
                  boxShadow: monochrome ? undefined : row.type === 'add' ? 'inset 2px 0 0 var(--diff-add-gutter)' : row.type === 'del' ? 'inset 2px 0 0 var(--diff-del-gutter)' : undefined
                }}
              >
                {row.type === 'del' ? row.oldNo : row.newNo}
              </span>
              <span className={cn('shrink-0 select-none pr-1.5', monochrome ? 'text-subtle' : row.type === 'add' ? 'text-ok' : row.type === 'del' ? 'text-danger' : 'text-transparent')}>
                {row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '}
              </span>
              <span className="whitespace-pre pr-4">{row.text || ' '}</span>
            </div>
          )
        )}
      </div>
    </div>
  )
}
