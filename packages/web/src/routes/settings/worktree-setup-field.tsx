import { productName } from '@/lib/product-name'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { ApiError, putConfig } from '@/api/client'
import { queryKeys, useHealth } from '@/api/queries'
import {
  WORKTREE_SETUP_DEFAULT_TIMEOUT_SECONDS,
  WORKTREE_SETUP_MAX_TIMEOUT_SECONDS,
  type ConfigResponse,
  type SetConfigInput,
} from '@open-mercato/cezar-api-client/contract/workspace'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { WorktreeSetupStatus } from './worktree-setup-status'
import { parseWorktreeSetupInput } from './worktree-setup-input'
import { SettingsField } from './settings-field'
import { useActiveProjectRoot } from './project-location'
import { RemoteSettingsNotice, useSettingsAdminRefresh } from './remote-settings-notice'

/**
 * Project settings → Worktrees → "Prepare new worktrees" (hearsay-tools/cezarion#917, spec
 * `.ai/specs/2026-10-07-worktree-setup.md`): the commands Squawk runs in every new task and worker
 * worktree before the agent starts. One command per line; blank lines are dropped.
 *
 * Editable on a local cockpit, or on a remote one whose host operator ran `cez remote-settings
 * enable` (hearsay-tools/cezarion#2428). These are commands the host runs, so any other cockpit
 * shows them read-only and the server refuses the write (409) whatever the client does.
 */
export function WorktreeSetupField({ config }: { config: ConfigResponse }) {
  const queryClient = useQueryClient()
  const health = useHealth()
  const refreshSettingsAdmin = useSettingsAdminRefresh()
  const projectRoot = useActiveProjectRoot()
  const configPath = projectRoot === null ? null : `${projectRoot.replace(/\/$/, '')}/.ai/cezar/config.json`
  // Unknown until health answers: read-only rather than editable-then-refused.
  const editable = health.data?.capabilities?.settingsAdmin === true

  const savedCommands = config.worktreeSetup?.commands ?? []
  const savedTimeout = config.worktreeSetup?.timeoutSeconds ?? WORKTREE_SETUP_DEFAULT_TIMEOUT_SECONDS
  const [text, setText] = useState(savedCommands.join('\n'))
  const [timeoutText, setTimeoutText] = useState(String(savedTimeout))

  const { commands, timeoutSeconds, invalid } = parseWorktreeSetupInput(text, timeoutText)
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
    onError: (error: Error) => {
      toast(error.message, { tone: 'danger' })
      // A 409 can mean the host withdrew the grant since the page loaded: show the field read-only.
      if (error instanceof ApiError && error.status === 409) void refreshSettingsAdmin()
    },
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
      hint="Runs in every new task and worker worktree before the agent starts, in order, stopping at the first failure. Leave commands empty to skip setup."
    >
      <RemoteSettingsNotice risk={`These commands run on the machine running ${productName('Cezarion')}`} />
      <WorktreeSetupStatus
        savedCommandCount={savedCommands.length}
        settingsAdmin={health.data?.capabilities?.settingsAdmin}
        configPath={configPath}
        issue={config.worktreeSetupIssue}
        invalid={invalid}
      >
        <textarea
          data-slot="worktree-setup-commands"
          aria-label="Worktree setup commands, one per line"
          rows={4}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={text}
          readOnly={!editable}
          disabled={save.isPending}
          onChange={(event) => setText(event.target.value)}
          className={`${control} min-h-24 w-full resize-y font-mono text-[13px] leading-relaxed`}
        />
        <p className="text-xs text-soft-foreground">
          Example only: <code>npm ci</code>. Commands run only after they are saved.
        </p>
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
      </WorktreeSetupStatus>
    </SettingsField>
  )
}
