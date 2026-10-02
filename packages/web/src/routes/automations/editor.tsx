import type { AutomationDefinition } from '@open-mercato/cezar-api-client'

import { PageFrame } from './page-frame'

export function AutomationEditor({ automation }: { automation?: AutomationDefinition; forge: { available: boolean; reason?: string }; timeZone: string; onSaved: () => void; onReload?: () => void }) {
  return <PageFrame title={automation ? 'Edit automation' : 'New automation'} subtitle="Pending the editor."><div /></PageFrame>
}
