import type { SelfUpdateStatus, SelfUpdateDevelopment, UpdateChannel } from '@open-mercato/cezar-api-client'

import { cez, init, unwrap, type ReadOptions } from './client'

/** cezar's own update state: install kind, channel, what the registry has, installed versions
 *  and the in-flight job. The GET answers the cached registry view and refreshes it behind. */
export async function getSelfUpdate(opts?: ReadOptions): Promise<SelfUpdateStatus> {
  return unwrap(await cez.api.v1.workspace['self-update'].$get({}, init(opts)), '/workspace/self-update')
}

/** Force a registry round trip. */
export async function refreshSelfUpdate(): Promise<SelfUpdateStatus> {
  return unwrap(await cez.api.v1.workspace['self-update'].refresh.$post({}), '/workspace/self-update/refresh')
}

/** The development channel's pickers: cezar worktrees and open PRs with a preview build. */
export async function getSelfUpdateDevelopment(opts?: ReadOptions & { refresh?: boolean }): Promise<SelfUpdateDevelopment> {
  return unwrap(
    await cez.api.v1.workspace['self-update'].development.$get({ query: opts?.refresh ? { refresh: '1' } : {} }, init(opts)),
    '/workspace/self-update/development',
  )
}

/** Persist the release channel (`stable`, `nightly` or `development`) in `~/.cezar/config.json`. */
export async function setSelfUpdateChannel(channel: UpdateChannel): Promise<SelfUpdateStatus> {
  return unwrap(
    await cez.api.v1.workspace['self-update'].channel.$put({ json: { channel } }),
    '/workspace/self-update/channel',
  )
}

/** Install `version`, activate it and restart. A version string is the only browser input. */
export async function applySelfUpdate(version: string): Promise<SelfUpdateStatus> {
  return unwrap(
    await cez.api.v1.workspace['self-update'].apply.$post({ json: { version } }),
    '/workspace/self-update/apply',
  )
}
