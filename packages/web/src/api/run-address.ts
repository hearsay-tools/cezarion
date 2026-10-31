import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'

/**
 * Request ownership and cache ownership differ for the boot project's list.
 *
 * The multi-project sidebar paints a quick-list per REGISTERED project, so a pin toggle on
 * another project's row would otherwise be sent with the scope of whichever project the URL
 * happens to name. The address sends the request to the run's OWN project and names the key
 * that project's run list is cached under.
 *
 * `boot: true` aliases the key scope to `'default'`: the boot project mounts UNSCOPED,
 * so its main view and the SSE patcher both live under the `'default'`-led keys — the boot
 * group must read that SAME entry, or its list and needs-you badge freeze at whatever the
 * expand-time fetch answered. The fetch itself still goes to the explicitly named project.
 */
export type ProjectAddress = Readonly<{ projectId: string; cacheScope: string }>
/**
 * The global Tasks page stands outside every `/p/:projectId`, so `queryScope()` would send the
 * BOOT project's id for a row that belongs to another project, and the archive would either 404
 * or (with a colliding id) land on the wrong task. Every caller that is already standing in the
 * run's own project captures the current scope instead.
 *
 * It is also the only way that page can learn a run's steps: its own index ships a deliberately
 * slim entry (no `steps`, no `runner`), and whether a finished task can be reopened is a question
 * only the full record answers.
 *
 * Another project's handoff journal, for a row of All tasks (hearsay-tools/cezarion#1616): the
 * project is named explicitly, since `queryScope()` is the boot project there.
 */
export type RunAddress = ProjectAddress & Readonly<{ runId: string }>

type AddressOptions = { projectId?: string | undefined; cacheScope?: string | undefined; boot?: boolean }

/** Capture before asynchronous work; only callers that explicitly need late scope pass a getter. */
export function projectAddress(options: AddressOptions = {}): ProjectAddress {
  const projectId = options.projectId ?? queryScope()
  return { projectId, cacheScope: options.cacheScope ?? (options.boot ? 'default' : projectId) }
}

export function runAddress(runId: string, options: AddressOptions = {}): RunAddress {
  return { ...projectAddress(options), runId }
}
