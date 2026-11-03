/** Navigation labels used by user-facing directions. Checked against the cockpit. */
export const CONTROL_LOCATIONS = {
  general: ['Settings', 'General'],
  webhooks: ['Settings', 'General', 'Webhooks'],
  providers: ['Settings', 'Agents', 'Providers'],
  projects: ['Settings', 'Projects'],
  worktrees: ['Settings', 'Worktrees'],
  sidebar: ['Settings', 'Sidebar'],
} as const;

export function controlLocation(
  control: keyof typeof CONTROL_LOCATIONS,
  separator = ' → ',
): string {
  return CONTROL_LOCATIONS[control].join(separator);
}
