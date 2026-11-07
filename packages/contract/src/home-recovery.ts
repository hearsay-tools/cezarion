import { z } from 'zod';

/** HomeStore keys, never an absolute path or a caller-selected filesystem location. */
export const HOME_FILE_PATTERN = /^(?:(?:config\.json(?:\.bak)?|agent-accounts\.json|ui-state\.json|server\.json|server\.install\.lock)|(?:remote-settings|server-instances)\/[a-zA-Z0-9-]+\.(?:json|install\.lock))$/;
export const homeFileSchema = z.string().regex(HOME_FILE_PATTERN);
export type HomeFile = z.infer<typeof homeFileSchema>;

export const homeRecoveryFileSchema = z.object({
  file: homeFileSchema,
  reason: z.enum(['reset', 'outside-write']),
  detectedAt: z.iso.datetime(),
  canRestore: z.boolean(),
});
export type HomeRecoveryFile = z.infer<typeof homeRecoveryFileSchema>;

/** Shared by HTTP and the trusted-only home:recovery topic. File content never leaves HomeStore. */
export const homeRecoverySchema = z.object({ files: z.array(homeRecoveryFileSchema) });
export type HomeRecovery = z.infer<typeof homeRecoverySchema>;

export const homeRecoveryActionSchema = z.object({ file: homeFileSchema, detectedAt: z.iso.datetime() }).strict();
export type HomeRecoveryAction = z.infer<typeof homeRecoveryActionSchema>;
