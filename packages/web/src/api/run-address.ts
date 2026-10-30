import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'

/** Request ownership and cache ownership differ for the boot project's list. */
export type ProjectAddress = Readonly<{ projectId: string; cacheScope: string }>
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
