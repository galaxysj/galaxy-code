import type { GitCommand, PromptMentions } from '@shared/types'

export const GIT_COMMANDS: Record<GitCommand, { label: string; detail: string }> = {
  commit: { label: 'Commit', detail: 'Have the agent commit the current changes.' },
  'commit-push': { label: 'Commit & Push', detail: 'Have the agent commit the current changes, then push.' }
}

/** The command a chip label stands for, so a sent message can be edited again. */
export const gitCommandFor = (label: string): GitCommand | undefined =>
  (Object.keys(GIT_COMMANDS) as GitCommand[]).find((command) => GIT_COMMANDS[command].label === label)

/** The token a picked git command takes in the message. Like every pick it is "@ name": the chip icon covers the @. */
export const gitToken = (command: GitCommand): string => `@ ${GIT_COMMANDS[command].label}`

/** A message that asks the agent to run a git command, as if it was picked from the / menu. */
export function gitCommandMessage(command: GitCommand): { text: string; mentions: PromptMentions } {
  const token = gitToken(command)
  return {
    text: token,
    mentions: { skills: [], files: [], chats: [], browser: false, tools: [], git: command, chips: [{ token, kind: 'git', label: GIT_COMMANDS[command].label }] }
  }
}
