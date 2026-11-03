import {
  WORKTREE_SETUP_MAX_COMMAND_LENGTH,
  WORKTREE_SETUP_MAX_COMMANDS,
  WORKTREE_SETUP_MAX_TIMEOUT_SECONDS,
} from '@open-mercato/cezar-api-client/contract/workspace'

/** Parse the editor values and report the first error, in the field's validation order. */
export function parseWorktreeSetupInput(text: string, timeoutText: string) {
  const commands = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const timeoutSeconds = Number(timeoutText)
  const invalid =
    commands.length > WORKTREE_SETUP_MAX_COMMANDS
      ? `Enter at most ${WORKTREE_SETUP_MAX_COMMANDS} commands.`
      : commands.some((command) => command.length > WORKTREE_SETUP_MAX_COMMAND_LENGTH)
        ? `Keep each command under ${WORKTREE_SETUP_MAX_COMMAND_LENGTH.toLocaleString('en-US')} characters.`
        : timeoutText.trim() === '' ||
            !Number.isInteger(timeoutSeconds) ||
            timeoutSeconds < 1 ||
            timeoutSeconds > WORKTREE_SETUP_MAX_TIMEOUT_SECONDS
          ? `Enter a whole number of seconds from 1 to ${WORKTREE_SETUP_MAX_TIMEOUT_SECONDS}.`
          : null
  return { commands, timeoutSeconds, invalid }
}
