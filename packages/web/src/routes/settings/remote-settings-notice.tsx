import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect } from 'react'
import { queryKeys, useHealth } from '@/api/queries'

/**
 * Re-reads whether this cockpit may edit host settings: health (the capability) and the Agent
 * config listing (its `editable` flag). The host operator grants and withdraws remote settings
 * administration outside the cockpit, and a remote cockpit gets no live health push, so an editor
 * re-reads both when it opens and after the server refuses a save. Returns the refresh, which
 * resolves once both reads end.
 */
export function useSettingsAdminRefresh({ onOpen = true }: { onOpen?: boolean } = {}): () => Promise<void> {
  const queryClient = useQueryClient()
  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.health }),
      queryClient.invalidateQueries({ queryKey: queryKeys.agentConfig }),
    ])
  }, [queryClient])
  useEffect(() => {
    if (onOpen) void refresh()
  }, [onOpen, refresh])
  return refresh
}

/** The host command that grants remote settings administration (hearsay-tools/cezarion#2428). */
export const REMOTE_SETTINGS_ENABLE_COMMAND = 'cez remote-settings enable'

/**
 * The warning above a settings editor whose content runs on the host, shown only when the host
 * operator granted remote settings administration. Admitted users can save commands the host
 * runs, so the cockpit says so where they edit them.
 */
export function RemoteSettingsNotice({ risk }: { risk: string }) {
  const health = useHealth()
  if (health.data?.capabilities?.remoteSettingsAdmin !== true) return null
  return (
    <p
      role="note"
      data-slot="remote-settings-notice"
      className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[13px] text-foreground"
    >
      Remote settings administration is on. {risk}, and anyone who can open this cockpit can change them. The
      host operator turns this off with{' '}
      <code>cez remote-settings disable</code>.
    </p>
  )
}
