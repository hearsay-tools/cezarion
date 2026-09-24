import { describe, expect, it } from 'vitest';
import { artifactListSchema, artifactParamsSchema, fileLinkQuerySchema, fileLinkResultSchema, filePreviewDataSchema, publishedArtifactSchema } from '@open-mercato/cezar-contract';

const metadata = { id: 'c0b82ee1-57c0-4bd4-b8b8-4b55f77ba230', runId: '12345678-1234-4234-8234-123456789012', name: 'notes.md', sourcePath: '/tmp/notes.md', createdAt: '2026-09-23T21:00:00.000Z', size: 0, sha256: 'a'.repeat(64) };
describe('artifact wire contract', () => {
  it('validates bounded metadata, UUIDs and hashes', () => {
    expect(publishedArtifactSchema.parse(metadata)).toEqual(metadata);
    expect(publishedArtifactSchema.safeParse({ ...metadata, sourcePath: '/' + 'x'.repeat(8191) }).success).toBe(true);
    for (const patch of [{ id: '../escape' }, { runId: '' }, { name: 'x'.repeat(256) }, { sourcePath: '/'.repeat(8193) }, { sourcePath: 'relative.md' }, { createdAt: 'yesterday' }, { size: -1 }, { sha256: 'not-a-hash' }]) {
      expect(publishedArtifactSchema.safeParse({ ...metadata, ...patch }).success).toBe(false);
    }
    expect(artifactListSchema.parse({ artifacts: [metadata] })).toEqual({ artifacts: [metadata] });
    expect(artifactListSchema.safeParse({ artifacts: Array.from({ length: 65 }, () => metadata) }).success).toBe(false);
    expect(artifactParamsSchema.safeParse({ id: metadata.runId, artifactId: '../escape' }).success).toBe(false);
  });
  it('allows optional wire fields to be omitted without introducing keys', () => {
    const file = { type: 'file', path: 'notes.md', size: 0, binary: false, tooLarge: false, source: 'worktree' };
    expect(filePreviewDataSchema.parse(file)).toEqual(file);
    expect(Object.keys(filePreviewDataSchema.parse(file))).not.toContain('content');
    expect(Object.keys(filePreviewDataSchema.parse(file))).not.toContain('artifact');
    expect(fileLinkResultSchema.parse({ type: 'unpublished', path: '/tmp/report.md', reason: 'Publish it first' }).type).toBe('unpublished');
    expect(fileLinkQuerySchema.parse({ path: 'notes.md' })).toEqual({ path: 'notes.md' });
    expect(fileLinkQuerySchema.safeParse({ path: '', raw: 'yes' }).success).toBe(false);
  });
});
