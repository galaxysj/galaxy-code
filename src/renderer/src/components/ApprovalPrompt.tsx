import { ChevronDown, Monitor, ShieldAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ToolItem } from '@shared/types'
import { basename, cn } from '../lib/utils'
import { toolActivityTitle } from '../lib/toolActivity'
import { useStore } from '../store'
import { Button } from './ui'
import { DiffStat, DiffView } from './DiffView'

/** Replaces the message box while a concrete action is waiting for approval. */
export function ApprovalPrompt({ chatId, item, remaining, onRespond }: {
  chatId: string
  item: ToolItem
  remaining: number
  onRespond(id: string): void
}): ReactNode {
  const approval = item.approval!
  const [note, setNote] = useState('')
  const [noting, setNoting] = useState(false)
  const [details, setDetails] = useState(false)
  const sending = useRef(false)
  const notify = useStore((s) => s.notify)
  const input = item.input as Record<string, unknown> | null
  const command = item.meta?.command ?? (typeof input?.command === 'string' ? input.command : '')
  const content = command || (item.input ? JSON.stringify(item.input, null, 2) : item.detail || '')
  const diffs = item.meta?.diffs ?? []
  const fileEdit = item.tool === 'edit' || item.tool === 'create' || item.tool === 'memory'

  const respond = useCallback(async (decision: 'allow' | 'allow-session' | 'deny'): Promise<void> => {
    if (sending.current) return
    sending.current = true
    try {
      // The backend publishes the resolved item before acknowledging this request.
      await window.galaxy.chats.approve(chatId, approval.id, decision, decision === 'deny' ? note.trim() || undefined : undefined)
      onRespond(approval.id)
    } catch (err) {
      sending.current = false
      notify(err instanceof Error ? err.message : 'Could not respond to the permission request', 'error')
    }
  }, [chatId, approval.id, note, notify, onRespond])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || document.querySelector('[data-popover]')) return
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        // Giving away the whole computer takes a deliberate click.
        if (approval.fullAccess) return
        void respond('allow')
      } else if (event.key === 'Escape' && !(event.target as HTMLElement | null)?.closest('input, textarea')) {
        event.preventDefault()
        void respond('deny')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [respond, approval.fullAccess])

  if (approval.fullAccess) {
    return (
      <section role="region" aria-label="Full access request" className="composer-swap min-w-0 rounded-2xl border border-danger/40 bg-elev px-4 py-3.5 shadow-composer">
        <div className="flex items-start gap-2.5">
          <Monitor size={17} className="mt-0.5 shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold text-fg">Allow full access to the computer?</div>
            <p className="mt-1 text-[12.5px] leading-snug text-muted">The agent will see your screen and use your mouse and keyboard in any app until this turn ends. You cannot use your computer meanwhile. Press Esc at any time to take it back.</p>
            {approval.reason && <p className="mt-2 break-words text-[13px] text-fg">{approval.reason}</p>}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-end gap-1.5">
          <Button size="sm" className="mr-auto" onClick={() => void respond('deny')}>Decline</Button>
          {approval.sessionKey && approval.sessionLabel && <Button size="sm" title={approval.sessionLabel} onClick={() => void respond('allow-session')}>Allow in this chat</Button>}
          <Button variant="danger" size="sm" onClick={() => void respond('allow')}>Allow full access</Button>
        </div>
      </section>
    )
  }

  return (
    <section role="region" aria-label="Permission request" className="composer-swap min-w-0 rounded-2xl bg-elev px-4 py-3.5 shadow-composer">
      <div className="flex items-start gap-2.5">
        <ShieldAlert size={17} className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-medium text-fg">Allow this action?</span>
            {remaining > 1 && <span className="text-[11.5px] text-subtle">1 of {remaining}</span>}
          </div>
          <div className="mt-1 break-words text-[13px] text-fg">{toolActivityTitle(item)}</div>
          {approval.reason && <p className="mt-1 text-[12px] leading-snug text-muted">{approval.reason}</p>}
        </div>
      </div>
      {fileEdit && diffs.length > 0 ? (
        <div role="region" aria-label="Proposed file changes" tabIndex={0} className="activity-output-surface activity-reveal mt-2.5 max-h-28 min-w-0 max-w-full overflow-auto overscroll-contain rounded-lg border border-line">
          {diffs.map((diff, index) => (
            <div key={`${diff.path}:${index}`} className="border-b border-line last:border-b-0">
              <div className="sticky top-0 z-10 flex h-8 items-center gap-2 border-b border-line bg-elev px-3">
                <span className="min-w-0 flex-1 truncate text-[12px] text-fg" title={diff.path}>{basename(diff.path)}</span>
                <DiffStat added={diff.added} removed={diff.removed} />
              </div>
              <DiffView diff={diff} maxHeight={null} />
            </div>
          ))}
        </div>
      ) : content && (
        <div className="mt-2.5 overflow-hidden rounded-lg border border-line bg-inset">
          <button type="button" onClick={() => setDetails(!details)} aria-expanded={details} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-muted transition-colors hover:text-fg">
            <span className="min-w-0 flex-1 truncate">{command || 'Action details'}</span>
            <ChevronDown size={12} className={cn('picker-chevron shrink-0', details && 'rotate-180')} />
          </button>
          {details && <pre className="activity-reveal selectable max-h-44 overflow-auto whitespace-pre-wrap break-words border-t border-line px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-muted">{content}</pre>}
        </div>
      )}
      {noting && (
        <input autoFocus value={note} onChange={(event) => setNote(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void respond('deny')
          }
          if (event.key === 'Escape') {
            event.stopPropagation()
            setNoting(false)
          }
        }} placeholder="Tell the agent what to do instead" className="composer-swap mt-2.5 h-8 w-full rounded-lg border border-line-strong bg-inset px-2.5 text-[12.5px] placeholder:text-subtle" />
      )}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-1.5">
        <Button variant="ghost" size="sm" className="mr-auto" onClick={() => noting ? void respond('deny') : setNoting(true)}>{noting ? 'Send and decline' : 'Decline with a note'}</Button>
        <Button size="sm" onClick={() => void respond('deny')}>Decline</Button>
        {approval.sessionKey && approval.sessionLabel && <Button size="sm" title={approval.sessionLabel} onClick={() => void respond('allow-session')}>Allow in this chat</Button>}
        <Button variant="primary" size="sm" onClick={() => void respond('allow')}>Allow <kbd className="font-sans text-[10.5px] opacity-60">⌘↵</kbd></Button>
      </div>
    </section>
  )
}
