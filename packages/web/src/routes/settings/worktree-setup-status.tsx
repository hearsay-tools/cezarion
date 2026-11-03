import type { ReactNode } from 'react'

import { REMOTE_SETTINGS_ENABLE_COMMAND } from './remote-settings-notice'

interface WorktreeSetupStatusProps {
  savedCommandCount: number
  settingsAdmin: boolean | undefined
  configPath: string | null
  issue: string | null
  invalid: string | null
  children: ReactNode
}

/** Keep the saved empty state before the controls and diagnostics after them. */
export function WorktreeSetupStatus({
  savedCommandCount, settingsAdmin, configPath, issue, invalid, children,
}: WorktreeSetupStatusProps) {
  return (
    <>
      {savedCommandCount === 0 && issue === null ? (
        <p data-slot="worktree-setup-empty" className="text-sm text-foreground">
          No setup commands configured. No commands will run in new worktrees.
        </p>
      ) : null}
      {children}
      {settingsAdmin === false ? (
        <p data-slot="worktree-setup-readonly" className="text-xs text-foreground">
          Edit <code>worktreeSetup.commands</code> in{' '}
          {configPath === null ? (
            <>the project’s <code>.ai/cezar/config.json</code></>
          ) : (
            <code className="break-all">{configPath}</code>
          )}{' '}
          on the machine running Cezarion. Valid file edits apply to new worktrees; no restart is needed. To edit
          here, the host operator runs <code>{REMOTE_SETTINGS_ENABLE_COMMAND}</code>.
        </p>
      ) : null}
      {issue !== null ? (
        <p data-slot="worktree-setup-issue" className="text-[11px] text-danger">
          config.json has an invalid worktreeSetup ({issue}) — saving replaces it.
        </p>
      ) : null}
      {invalid !== null ? (
        <p data-slot="worktree-setup-invalid" className="text-[11px] text-danger">
          {invalid}
        </p>
      ) : null}
    </>
  )
}
