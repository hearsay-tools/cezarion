import type { PublishedArtifact } from './artifacts.ts';

/** Shared display name for a published HTML snapshot. */
export function reportTitle(artifact: Pick<PublishedArtifact, 'name' | 'title'>): string {
  return artifact.title || artifact.name.replace(/(.+)\.[^.]+$/, '$1');
}
