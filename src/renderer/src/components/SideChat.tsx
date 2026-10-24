import { MessagesSquare } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Item } from '@shared/types'
import { ChatScope, useStore, type PanelTab } from '../store'
import { Composer } from './Composer'
import { Timeline } from './timeline/Timeline'
import { Button, Modal } from './ui'

const EMPTY: Item[] = []

type SideTab = Extract<PanelTab, { type: 'side' }>

/** A throwaway chat beside the main one, with the same timeline and message box, scoped to its own chat. */
export function SideChatPane({ tab }: { tab: SideTab }): ReactNode {
  const chat = useStore((s) => s.chats[tab.chatId])
  const items = useStore((s) => s.items[tab.chatId]) ?? EMPTY
  if (!chat) return null
  return (
    <ChatScope.Provider value={chat.id}>
      <div className="flex h-full flex-col">
        {items.length === 0 && !chat.reverted ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
            <MessagesSquare size={22} className="text-subtle" />
            <div className="text-[14px] font-medium text-fg">Side chat</div>
            <div className="max-w-[300px] text-[12px] leading-relaxed text-subtle">Ask a quick question or hand off a small task without interrupting the main chat. It is deleted when you close this tab.</div>
          </div>
        ) : (
          <Timeline chat={chat} items={items} root={tab.root} />
        )}
        <div className="shrink-0">
          <Composer />
        </div>
      </div>
    </ChatScope.Provider>
  )
}

/** Asks before a side chat tab closes, since closing deletes the chat for good. */
export function CloseSideChatDialog(): ReactNode {
  const tabId = useStore((s) => s.closingSideTab)
  const setClosing = useStore((s) => s.setClosingSideTab)
  const closeTab = useStore((s) => s.closePanelTab)
  if (!tabId) return null
  return (
    <Modal onClose={() => setClosing(null)} className="w-[400px] max-w-full p-5">
      <div className="text-[14px] font-semibold text-fg">Close side chat?</div>
      <div className="mt-1.5 text-[12.5px] leading-relaxed text-muted">Side chats are not saved. Closing this tab deletes the conversation and stops any work still running in it.</div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={() => setClosing(null)}>Cancel</Button>
        <Button variant="danger" size="sm" autoFocus onClick={() => closeTab(tabId, true)}>Close and delete</Button>
      </div>
    </Modal>
  )
}
