import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { putConfig } from '@/api/client'
import { queryKeys, useHealth } from '@/api/queries'
import {
  WORKTREE_SETUP_DEFAULT_TIMEOUT_SECONDS,
  WORKTREE_SETUP_MAX_COMMAND_LENGTH,
  WORKTREE_SETUP_MAX_COMMANDS,
  WORKTREE_SETUP_MAX_TIMEOUT_SECONDS,
  type ConfigResponse,
  type SetConfigInput,
} from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { SettingsField } from './settings-field'

/**
 * Project settings → Worktrees → "Prepare new worktrees" (#917, spec
 * `.ai/specs/2026-10-07-worktree-setup.md`): the commands Cezar runs in every new task and worker
 * worktree before the agent starts. One command per line; blank lines are dropped.
 *
 * Editable only on a local cockpit. These are commands the host runs, so a hosted cockpit shows
 * them read-only and the server refuses the write (409) whatever the client does.
 */
export function WorktreeSetupField({ config }: { config: ConfigResponse }) {
  const queryClient = useQueryClient()
  const health = useHealth()
  // Unknown until health answers: read-only rather than editable-then-refused.
  const editable = health.data?.capabilities?.localHandoff === true

  const savedCommands = config.worktreeSetup?.commands ?? []
  const savedTimeout = config.worktreeSetup?.timeoutSeconds ?? WORKTREE_SETUP_DEFAULT_TIMEOUT_SECONDS
  const [text, setText] = useState(savedCommands.join('\n'))
  const [timeoutText, setTimeoutText] = useState(String(savedTimeout))

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
  // An invalid value on disk is a change to make even when the box matches "nothing saved".
  const unchanged =
    config.worktreeSetupIssue === null &&
    commands.length === savedCommands.length &&
    commands.every((command, index) => command === savedCommands[index]) &&
    (commands.length === 0 || timeoutSeconds === savedTimeout)

  const save = useMutation({
    mutationFn: (patch: SetConfigInput) => putConfig(patch),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.config, result)
      setText(commands.join('\n'))
      toast(commands.length === 0 ? 'Worktree setup cleared' : 'Worktree setup saved')
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const submit = () =>
    save.mutate({
      worktreeSetup:
        commands.length === 0
          ? null
          : {
              commands,
              // The default is never written into config.json (it stays a default).
              ...(timeoutSeconds === WORKTREE_SETUP_DEFAULT_TIMEOUT_SECONDS ? {} : { timeoutSeconds }),
            },
    })

  const control =
    'block rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 read-only:bg-muted read-only:text-muted-foreground'

  return (
    <SettingsField
      title="Prepare new worktrees"
      hint="Runs in every new task and worker worktree before the agent starts, in order, stopping at the first failure. Empty = none."
    >
      <textarea
        data-slot="worktree-setup-commands"
        aria-label="Worktree setup commands, one per line"
        rows={4}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder="npm ci"
        value={text}
        readOnly={!editable}
        disabled={save.isPending}
        onChange={(event) => setText(event.target.value)}
        className={`${control} min-h-24 w-full resize-y font-mono text-[13px] leading-relaxed`}
      />
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-soft-foreground">
          <span>Timeout per command</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={WORKTREE_SETUP_MAX_TIMEOUT_SECONDS}
            step={1}
            data-slot="worktree-setup-timeout"
            value={timeoutText}
            readOnly={!editable}
            disabled={save.isPending}
            onChange={(event) => setTimeoutText(event.target.value)}
            className={`${control} min-h-11 w-28 md:min-h-0`}
          />
          <span>seconds</span>
        </label>
        <Button
          type="button"
          variant="primary"
          size="sm"
          className="min-h-11 self-start md:min-h-0"
          data-action="worktree-setup-save"
          disabled={!editable || unchanged || invalid !== null || save.isPending}
          onClick={submit}
        >
          Save setup
        </Button>
      </div>
      {health.data?.capabilities?.localHandoff === false ? (
        <p data-slot="worktree-setup-readonly" className="text-[11px] text-soft-foreground">
          Setup commands can be edited only on the machine running Cezar.
        </p>
      ) : null}
      {config.worktreeSetupIssue !== null ? (
        <p data-slot="worktree-setup-issue" className="text-[11px] text-danger">
          config.json has an invalid worktreeSetup ({config.worktreeSetupIssue}) — saving replaces it.
        </p>
      ) : null}
      {invalid !== null ? (
        <p data-slot="worktree-setup-invalid" className="text-[11px] text-danger">
          {invalid}
        </p>
      ) : null}
    </SettingsField>
  )
}
