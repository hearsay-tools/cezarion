import type { BackendCheck } from '@open-mercato/cezar-api-client'
import type { StatusDotTone } from '@/components/status-dot'

/**
 * One reading of a probed tool, shared by the desktop Tools menu and the /tools page (the phone's
 * only door to the same probes) so the two surfaces cannot drift: green when present, red when
 * not. The dot is never the only carrier — callers pair it with the words below.
 */
export const toolTone = (check: BackendCheck): StatusDotTone => (check.available ? 'success' : 'danger')

/** The state word /tools prints beside the dot. */
export const toolStateLabel = (check: BackendCheck): string => (check.available ? 'Installed' : 'Not installed')

/** Where a missing tool is set up: Settings → Agents, resolved by the project-router `Link`. */
export const TOOL_SETTINGS_PATH = '/settings/agents'

/** Neutral link style for the touch-first surfaces: `--foreground`, underline on hover and
 *  keyboard focus, the app's focus ring, and a 44px target wherever there is no hover. */
export const TOOL_LINK_CLASS =
  'inline-flex items-center rounded-sm text-xs font-medium text-foreground hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11 no-hover:min-h-11'
