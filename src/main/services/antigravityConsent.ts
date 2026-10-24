import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'

let accepted = false
let pending: Promise<void> | null = null
let present: ((requestId: string) => BrowserWindow | null) | null = null
let active: { id: string; owner: number; finish(allow: boolean): void } | null = null

export function configureAntigravityConsent(presenter: (requestId: string) => BrowserWindow | null): void {
  present = presenter
}

export function answerAntigravityConsent(requestId: string, allow: boolean, owner: number): void {
  if (active?.id === requestId && active.owner === owner) active.finish(allow)
}

/** Consent lasts for this app run only, and precedes any third-party process. */
export function confirmAntigravityUse(showAgain = false): Promise<void> {
  if (pending) return pending
  if (showAgain) accepted = false
  if (accepted) return Promise.resolve()
  pending = new Promise<void>((resolve, reject) => {
    const id = randomUUID()
    const win = present?.(id)
    if (!win || win.isDestroyed()) {
      reject(new Error('An app window is required to confirm Antigravity use.'))
      return
    }
    const closed = (): void => finish(false)
    const finish = (allow: boolean): void => {
      if (active?.id !== id) return
      active = null
      win.removeListener('closed', closed)
      win.webContents.removeListener('render-process-gone', closed)
      win.webContents.removeListener('did-start-loading', closed)
      if (allow) {
        accepted = true
        resolve()
      } else reject(new Error('Antigravity connection cancelled.'))
    }
    active = { id, owner: win.id, finish }
    win.once('closed', closed)
    win.webContents.once('render-process-gone', closed)
    win.webContents.once('did-start-loading', closed)
  }).finally(() => { pending = null })
  return pending
}
