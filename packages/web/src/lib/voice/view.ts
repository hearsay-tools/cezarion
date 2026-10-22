import type { VoiceView } from '@open-mercato/cezar-api-client/contract/voice'

/**
 * Which cockpit page is on screen, for the voice decision (hearsay-tools/cezarion#1463). Takes the
 * path without its `/p/:projectId` prefix (`useProjectPathname`).
 */
const PAGES: [prefix: string, view: VoiceView][] = [
  ['/tasks', 'task'],
  ['/compare', 'compare'],
  ['/new', 'new-task'],
  ['/github', 'github'],
  ['/git', 'git'],
  ['/automations', 'automations'],
  ['/inbox', 'inbox'],
  ['/settings', 'settings'],
]

export function voiceViewOf(projectPath: string): VoiceView {
  for (const [prefix, view] of PAGES) {
    if (projectPath === prefix || projectPath.startsWith(`${prefix}/`)) return view
  }
  return 'other'
}
