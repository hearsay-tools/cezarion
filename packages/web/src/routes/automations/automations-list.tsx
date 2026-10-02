import type { AutomationsResponse } from '@open-mercato/cezar-api-client'

import { PageFrame, PageState } from './page-frame'

export function AutomationsList({ data, error }: { data: AutomationsResponse | undefined; error: string; refresh: () => Promise<void> }) {
  return <PageFrame title="Automations" subtitle="Schedules and GitHub checks run while Cezarion is open."><PageState text={error || (data ? `${data.automations.length} automations` : 'Loading automations…')} /></PageFrame>
}
