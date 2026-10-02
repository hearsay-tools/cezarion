import { useState } from 'react'
import { useParams } from 'react-router'
import { ZapIcon } from '@/components/design-icons'

import { useHealth } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { Link, useNavigate } from '@/lib/project-router'
import { AutomationEditor } from './editor'
import { AutomationsList } from './automations-list'
import { AutomationLogScreen } from './log'
import { PageFrame, PageState } from './page-frame'
import { useAutomations } from './use-automations'

export function AutomationsRoute({ mode = 'list' }: { mode?: 'list' | 'new' | 'edit' | 'log' }) {
  const { automationId } = useParams()
  const navigate = useNavigate()
  const { data, error, refresh } = useAutomations()
  // Bumped by the editor's Reload and nothing else: a background revision change must reach the
  // user as the save-time 409, not as a form that silently resets under their typing.
  const [reloadToken, setReloadToken] = useState(0)
  // Automations are opt-in (#801). A bookmarked `/automations…` URL still routes here with the
  // capability off, so the view says so rather than rendering an editor whose every request
  // would 409. `!== true` deliberately: only a health payload that HAS answered switches this on.
  const health = useHealth()
  const healthKnown = health.data !== undefined
  const automationsOff = healthKnown && health.data.capabilities?.automations !== true

  // Every mode below needs the capability answer, so none of them renders before health has given
  // it. Without this a cold deep link into `/automations/new` painted a full creation form on a
  // gated server — and a submit inside that window POSTs straight into a 409.
  if (!healthKnown) {
    return (
      <div data-route="automations" className="task-flow-page flex min-h-full flex-col">
        <PageState text="Loading automations…" />
      </div>
    )
  }

  // Before every mode branch, so all four `/automations*` routes degrade the same way.
  if (automationsOff) {
    return (
      <div data-route="automations" className="task-flow-page flex min-h-full flex-col">
        <CenteredState
          icon={<ZapIcon />}
          tone="neutral"
          title="Automations are off"
          subtitle="This server does not run schedules, poll GitHub or launch tasks from them. Set CEZ_AUTOMATIONS=1 and restart cezar to turn automations on."
          heading="h2"
        />
      </div>
    )
  }

  const saved = () => { navigate('/automations'); void refresh() }
  const found = data?.automations.find((item) => item.id === automationId)

  // The editor and the log read the forge and the zone from the list, so they wait for it too. A
  // failed REFRESH with data already in hand must not tear the screen down under an open draft.
  if (!data) {
    return error
      ? <PageFrame title="Automations" subtitle="Could not load automations."><div className="grid justify-items-start gap-3"><PageState text={error} /><Button variant="outline" onClick={() => void refresh()}>Retry</Button></div></PageFrame>
      : <div data-route="automations" className="task-flow-page flex min-h-full flex-col"><PageState text="Loading automations…" /></div>
  }

  const forge = { available: data.available, ...(data.reason ? { reason: data.reason } : {}) }
  if (mode === 'new') return <AutomationEditor forge={forge} timeZone={data.timeZone} onSaved={saved} />
  if (mode === 'edit') {
    if (!found) return <PageFrame title="Automation not found" subtitle="This automation may have been removed."><Button asChild variant="outline"><Link to="/automations">Back to automations</Link></Button></PageFrame>
    return <AutomationEditor key={`${found.id}:${reloadToken}`} automation={found} forge={forge} timeZone={data.timeZone} onSaved={saved} onReload={() => void refresh().then(() => setReloadToken((token) => token + 1))} />
  }
  return automationId
    ? <AutomationLogScreen automationId={automationId} automationName={found?.name} timeZone={data.timeZone} />
    : <PageState text="Automation not found." />
}
