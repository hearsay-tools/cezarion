import { useHealth } from '@/api/queries'

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
