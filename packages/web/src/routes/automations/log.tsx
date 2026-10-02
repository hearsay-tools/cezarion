import { PageFrame, PageState } from './page-frame'

export function AutomationLogScreen({ automationName }: { automationId: string; automationName?: string; timeZone: string }) {
  return <PageFrame title="Execution log" subtitle={automationName ?? 'Automation activity'}><PageState text="Loading execution log…" /></PageFrame>
}
