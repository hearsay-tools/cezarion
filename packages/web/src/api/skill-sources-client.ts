import type {
  AddTeamSkillSource,
  SetTeamSkillSourceEnabled,
  TeamSkillSourceRef,
  TeamSkillSourcesResponse,
} from '@open-mercato/cezar-api-client'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'

import { cez, init, unwrap, type ReadOptions } from './client'

/** The query key of `GET /skills/sources`: a child of `skills`, so a Refresh re-reads it too. */
export const skillSourcesKey = () => [queryScope(), 'skills', 'sources'] as const

/** The configured team skill sources with each one's load state (hearsay-tools/cezarion#279). */
export async function getSkillSources(opts?: ReadOptions): Promise<TeamSkillSourcesResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].skills.sources.$get({ param: { projectId: queryScope() } }, init(opts)),
    '/skills/sources',
  )
}

/** Add a source to `skillsRepos`; the server starts fetching it and answers it as loading. */
export async function addSkillSource(json: AddTeamSkillSource): Promise<TeamSkillSourcesResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].skills.sources.$post({ param: { projectId: queryScope() }, json }),
    '/skills/sources',
  )
}

/** Enable or disable a source. Its per-skill switches are kept either way. */
export async function setSkillSourceEnabled(json: SetTeamSkillSourceEnabled): Promise<TeamSkillSourcesResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].skills.sources.$patch({ param: { projectId: queryScope() }, json }),
    '/skills/sources',
  )
}

/** Remove a source from `skillsRepos`. Its per-skill switches stay for a later re-add. */
export async function removeSkillSource(json: TeamSkillSourceRef): Promise<TeamSkillSourcesResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].skills.sources.$delete({ param: { projectId: queryScope() }, json }),
    '/skills/sources',
  )
}

/** Fetch one source again: a failed source's Retry. */
export async function retrySkillSource(json: TeamSkillSourceRef): Promise<TeamSkillSourcesResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].skills.sources.retry.$post({ param: { projectId: queryScope() }, json }),
    '/skills/sources/retry',
  )
}
