import { CloudUpload, GitCommitHorizontal, type LucideIcon } from 'lucide-react'
import type { GitCommand, PromptMentions } from '@shared/types'
import { cleanError } from '../components/Settings'
import { useStore } from '../store'

export const GIT_COMMANDS: Record<GitCommand, { label: string; detail: string }> = {
  commit: { label: 'Commit', detail: 'Have the agent commit the current changes.' },
  'commit-push': { label: 'Commit & Push', detail: 'Have the agent commit the current changes, then push.' },
  push: { label: 'Push', detail: 'Have the agent push the current branch.' }
}

export const GIT_COMMAND_ICON: Record<GitCommand, LucideIcon> = { commit: GitCommitHorizontal, 'commit-push': GitCommitHorizontal, push: CloudUpload }

/** The command a chip label stands for, so a sent message can be edited again. */
export const gitCommandFor = (label: string): GitCommand | undefined =>
  (Object.keys(GIT_COMMANDS) as GitCommand[]).find((command) => GIT_COMMANDS[command].label === label)

/** The token a picked git command takes in the message. Like every pick it is "@ name": the chip icon covers the @. */
export const gitToken = (command: GitCommand): string => `@ ${GIT_COMMANDS[command].label}`

/** A message that asks the agent to run a git command, as if it was picked from the @ menu. */
export function gitCommandMessage(command: GitCommand): { text: string; mentions: PromptMentions } {
  const token = gitToken(command)
  return {
    text: token,
    mentions: { skills: [], files: [], chats: [], browser: false, tools: [], git: command, chips: [{ token, kind: 'git', label: GIT_COMMANDS[command].label }] }
  }
}

/** Whether the command runs here instead of asking the agent: Instant push for Push, Instant commit for the rest. */
export const isInstant = (command: GitCommand): boolean => {
  const { settings } = useStore.getState()
  return command === 'push' ? settings.instantPush : settings.instantCommit
}

/**
 * What the Git buttons do. With Instant commit on, the commit message model writes the
 * message and the commit happens here; with Instant push on, Push pushes here. Failures open
 * an error dialog. Otherwise the agent is asked. Without a chat, asking the agent starts a new one.
 */
export async function runGitCommand(command: GitCommand, chatId: string | null, cwd: string | undefined): Promise<void> {
  const state = useStore.getState()
  if (!isInstant(command) || !cwd) {
    const { text, mentions } = gitCommandMessage(command)
    await state.send(text, [], mentions, false, undefined, undefined, chatId)
    return
  }
  try {
    if (command === 'push') {
      const result = await window.galaxy.review.push(cwd)
      useStore.getState().notify(`Pushed ${result.branch} to ${result.remote}.`)
      return
    }
    const result = await window.galaxy.review.instantCommit(cwd, command === 'commit-push')
    const subject = result.message.split('\n')[0]
    useStore.getState().notify(result.pushed ? `Committed ${result.hash} and pushed to ${result.pushed.remote}: ${subject}` : `Committed ${result.hash}: ${subject}`)
  } catch (error) {
    useStore.setState({ gitError: cleanError(error) })
  }
}
