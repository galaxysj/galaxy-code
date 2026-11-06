import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import type { TaskEntry } from '@shared/types'
import { cn } from '../lib/utils'

/** A round blue checkbox: filled with a check when done, a half-filled ring while in progress, an empty ring when pending. */
export function TaskMark({ status, size = 15, className }: { status: TaskEntry['status']; size?: number; className?: string }): ReactNode {
  const blue = 'var(--slider)'
  return (
    <span
      aria-label={status === 'completed' ? 'Done' : status === 'in_progress' ? 'In progress' : 'Pending'}
      className={cn('relative inline-flex shrink-0 items-center justify-center rounded-full', className)}
      style={{
        width: size,
        height: size,
        border: `1.5px solid ${status === 'pending' ? 'var(--border-strong, currentColor)' : blue}`,
        background: status === 'completed' ? blue : 'transparent'
      }}
    >
      {status === 'completed' && <Check size={size * 0.62} strokeWidth={3.2} className="text-white" />}
      {status === 'in_progress' && <span className="rounded-full" style={{ width: size * 0.42, height: size * 0.42, background: blue }} />}
    </span>
  )
}
