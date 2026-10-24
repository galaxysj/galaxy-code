import { CircleAlert } from 'lucide-react'
import { useCallback, useState, type ReactNode } from 'react'
import { useStore } from '../store'
import { Button, Modal } from './ui'

export function AntigravityConsent({ requestId }: { requestId: string }): ReactNode {
  const [submitting, setSubmitting] = useState(false)
  const answer = useCallback(async (allow: boolean): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    try {
      await window.galaxy.acp.answerConsent(requestId, allow)
      if (useStore.getState().antigravityConsent === requestId) useStore.setState({ antigravityConsent: null })
    } catch {
      setSubmitting(false)
      useStore.getState().notify('Could not save your choice. Please try again.', 'error')
    }
  }, [requestId, submitting])
  const cancel = useCallback(() => { void answer(false) }, [answer])

  return (
    <Modal onClose={cancel} className="w-[460px] max-w-full p-6">
      <div role="alertdialog" aria-modal="true" aria-labelledby="antigravity-warning-title" aria-describedby="antigravity-warning-description">
        <CircleAlert size={24} className="mb-4 text-warn" />
        <h2 id="antigravity-warning-title" className="text-[16px] font-semibold text-fg">Use unofficial Antigravity ACP?</h2>
        <div id="antigravity-warning-description" className="mt-3 space-y-3 text-[12.5px] leading-relaxed text-muted">
          <p>Third-party access may violate Google's terms and could result in restrictions or suspension of your Google account. Account safety cannot be guaranteed.</p>
          <p>Galaxy Code uses the unofficial agy-acp adapter, which is not provided or endorsed by Google. Continuing may download the adapter and Antigravity CLI.</p>
        </div>
        <div className="mt-3 flex gap-4 text-[12px] text-link">
          <button type="button" onClick={() => void window.galaxy.files.openExternal('https://github.com/shindgew/agy-acp')} className="hover:underline">Adapter source</button>
          <button type="button" onClick={() => void window.galaxy.files.openExternal('https://antigravity.google/terms')} className="hover:underline">Google terms</button>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button autoFocus disabled={submitting} onClick={cancel}>Cancel</Button>
          <Button disabled={submitting} onClick={() => void answer(true)}>I understand the risks</Button>
        </div>
      </div>
    </Modal>
  )
}
