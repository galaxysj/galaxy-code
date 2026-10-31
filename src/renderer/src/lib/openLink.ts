import { useStore } from '../store'

/** Opens a web link where Settings says to, or in the other browser when Option is held. */
export async function openLink(url: string, event?: { altKey?: boolean }): Promise<void> {
  const external = (useStore.getState().settings.browserOpenLinks === 'default') !== !!event?.altKey
  if (external || !/^https?:/i.test(url)) {
    await window.galaxy.files.openExternal(url)
    return
  }
  try {
    const id = await window.galaxy.browser.create()
    useStore.getState().addPanelTab({ id, type: 'browser', title: 'New tab' })
    await window.galaxy.browser.navigate(url, id)
  } catch (error) {
    useStore.getState().notify(error instanceof Error ? error.message : String(error), 'error')
  }
}
