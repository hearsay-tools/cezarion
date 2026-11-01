import type { PublishedArtifact } from '@open-mercato/cezar-api-client'

/** Shared display name for a published report. */
export function reportTitle(artifact: Pick<PublishedArtifact, 'name' | 'title'>): string {
  return artifact.title || artifact.name.replace(/(.+)\.[^.]+$/, '$1')
}
