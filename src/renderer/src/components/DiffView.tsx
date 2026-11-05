import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { FileDiff } from '@shared/types'
import { cn } from '../lib/utils'

interface Row {
  type: 'hunk' | 'add' | 'del' | 'ctx'
  text: string
  oldNo?: number
  newNo?: number
}

function parse(patch: string): Row[] {
  if (!patch) return []
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

/** Lines a streamed count gathers before it moves, varied a little so the two counts do not tick in step. */
function nextStep(): number {
  return 8 + Math.floor(Math.random() * 5)
}

/**
 * A streamed count that moves in steps of 8 to 12 rather than on every line, and lands on the exact value once the
 * edit is done. Counts that go down, as a patch is corrected, follow at once.
 */
function useSteppedCount(value: number, live: boolean): number {
  const [shown, setShown] = useState(value)
  const step = useRef(nextStep())
  useEffect(() => {
    if (!live || value < shown || value - shown >= step.current) {
      if (value !== shown) setShown(value)
      step.current = nextStep()
    }
  }, [value, live, shown])
  return shown
}

/** A number whose digits that change roll up: the old ones leave through the top as the new ones rise in. */
function RollingNumber({ value }: { value: number }): ReactNode {
  const [state, setState] = useState({ current: String(value), previous: null as string | null, step: 0 })
  const text = String(value)
  if (state.current !== text) setState({ current: text, previous: state.current, step: state.step + 1 })
  const { current, previous, step } = state
  // Digits line up from the right, so 98 → 104 rolls only the places that changed.
  const width = Math.max(current.length, previous?.length ?? 0)
  const now = current.padStart(width, ' ')
  const before = (previous ?? current).padStart(width, ' ')
  return (
    <>
      {[...now].map((digit, index) => {
        const old = before[index]
        if (previous === null || old === digit) return <span key={`${index}:${digit}`} className={digit === ' ' ? 'hidden' : undefined}>{digit}</span>
        return (
          <span key={`${index}:${step}`} className="roll-slot">
            {old !== ' ' && <span className="roll-out" onAnimationEnd={() => setState((s) => (s.step === step ? { ...s, previous: null } : s))}>{old}</span>}
            {digit !== ' ' && <span className="roll-in">{digit}</span>}
          </span>
        )
      })}
    </>
  )
}

/** +n -n that follows an edit while it is written, rolling up in steps as lines arrive. */
export function LiveDiffStat({ added, removed, live = false, className }: { added: number; removed: number; live?: boolean; className?: string }): ReactNode {
  const plus = useSteppedCount(added, live)
  const minus = useSteppedCount(removed, live)
  if (!plus && !minus) return null
  return (
    <span className={cn('inline-flex shrink-0 gap-1.5 font-mono text-[11.5px] tabular-nums', className)}>
      {plus > 0 && <span className="inline-flex text-ok">+<RollingNumber value={plus} /></span>}
      {minus > 0 && <span className="inline-flex text-danger">-<RollingNumber value={minus} /></span>}
    </span>
  )
}

export function DiffView({ diff, maxHeight = 420, monochrome = false }: { diff: FileDiff; maxHeight?: number | null; monochrome?: boolean }): ReactNode {
  const rows = useMemo(() => parse(diff.patch), [diff.patch])
  const chunks = useMemo(() => {
    const result: Row[][] = []
    for (let start = 0; start < rows.length; start += 200) result.push(rows.slice(start, start + 200))
    return result
  }, [rows])
  if (rows.length === 0) return <div className="px-3 py-2 text-[12px] text-subtle">No textual changes.</div>
  // Spreading every line into Math.max exceeds the argument limit on long diffs.
  const width = String(rows.reduce((largest, row) => Math.max(largest, row.newNo ?? row.oldNo ?? 0), 0)).length
  return (
    <div className={cn('selectable font-mono text-[12px] leading-[1.55]', maxHeight === null ? 'overflow-visible' : 'overflow-auto')} style={{ maxHeight: maxHeight ?? undefined }}>
      <div className="min-w-max">
        {chunks.map((chunk, chunkIndex) => (
          <div key={chunkIndex} style={rows.length > 1000 ? { contentVisibility: 'auto', containIntrinsicSize: `auto ${chunk.length * 18.6}px` } : undefined}>
        {chunk.map((row, index) =>
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
        ))}
      </div>
    </div>
  )
}
