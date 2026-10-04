import { PreviewPane, type PreviewPaneProps } from './preview-pane'
import { usePreviewServerStates } from './use-preview-server-states'

/**
 * The pane wired to the task's events: the switcher and the empty state read each server as the
 * transcript's cards do. A separate component so the pane itself stays a plain props-in view, and
 * so the event reducer rides the pane's lazy chunk instead of the layout's.
 */
export function ConnectedPreviewPane(props: Omit<PreviewPaneProps, 'serverStates'>) {
  const serverStates = usePreviewServerStates(props.run.id)
  return <PreviewPane {...props} serverStates={serverStates} />
}
