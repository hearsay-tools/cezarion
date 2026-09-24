import { z } from 'zod';

const pathSchema = z.string().min(1).max(8192).refine(value => !value.includes('\0'), 'Path contains NUL');
export const publishedArtifactSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  name: z.string().min(1).max(255),
  sourcePath: pathSchema.refine(value => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value), 'Expected an absolute source path'),
  createdAt: z.iso.datetime(),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type PublishedArtifact = z.infer<typeof publishedArtifactSchema>;

export const filePreviewDataSchema = z.object({
  type: z.literal('file'),
  path: pathSchema,
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  binary: z.boolean(),
  tooLarge: z.boolean(),
  content: z.string().optional(),
  source: z.enum(['worktree', 'project', 'artifact']),
  artifact: publishedArtifactSchema.optional(),
}).strict();
export type FilePreviewData = z.infer<typeof filePreviewDataSchema>;
export const fileLinkResultSchema = z.union([
  filePreviewDataSchema,
  z.object({
    type: z.enum(['unavailable', 'unpublished']),
    path: pathSchema,
    reason: z.string().min(1).max(4096),
  }).strict(),
]);
export type FileLinkResult = z.infer<typeof fileLinkResultSchema>;
export const artifactListSchema = z.object({ artifacts: z.array(publishedArtifactSchema).max(64) }).strict();
export const fileLinkQuerySchema = z.object({ path: pathSchema, raw: z.literal('1').optional() }).strict();
// Project mounts also carry projectId, validated by the outer project middleware.
export const artifactParamsSchema = z.object({ id: z.uuid(), artifactId: z.uuid() });
