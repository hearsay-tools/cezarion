import { z } from 'zod';

/** HomeStore keys, never an absolute path or a caller-selected filesystem location. */
export const HOME_FILE_PATTERN = /^(?:(?:config\.json(?:\.bak)?|agent-accounts\.json|ui-state\.json|server\.json|server\.install\.lock)|(?:remote-settings|server-instances)\/[a-zA-Z0-9-]+\.(?:json|install\.lock))$/;
export const homeFileSchema = z.string().regex(HOME_FILE_PATTERN);
export type HomeFile = z.infer<typeof homeFileSchema>;

const recoveryFile = z.object({
  file: homeFileSchema,
  detectedAt: z.iso.datetime(),
  canRestore: z.boolean(),
});
export const HOME_RECOVERY_REASONS = ['reset', 'outside-write', 'legacy-change'] as const;
export const homeRecoveryFileSchema = z.discriminatedUnion('reason', [
  recoveryFile.extend({ reason: z.literal('reset') }),
  recoveryFile.extend({ reason: z.literal('outside-write') }),
  recoveryFile.extend({ reason: z.literal('legacy-change'), canImport: z.boolean() }),
]);
export type HomeRecoveryFile = z.infer<typeof homeRecoveryFileSchema>;

/** Shared by HTTP and the trusted-only home:recovery topic. File content never leaves HomeStore. */
export const homeRecoverySchema = z.object({ files: z.array(homeRecoveryFileSchema) });
export type HomeRecovery = z.infer<typeof homeRecoverySchema>;

/** Readers ignore future reasons while still rejecting malformed rows they understand. */
export function filterHomeRecoveryReasons(value: unknown, reasons: readonly string[]): unknown {
  if (!value || typeof value !== 'object' || !('files' in value) || !Array.isArray(value.files)) return value;
  return { ...value, files: value.files.filter((row: unknown) => !(row && typeof row === 'object'
    && 'reason' in row && typeof row.reason === 'string' && !reasons.includes(row.reason))) };
}
export const homeRecoveryReaderSchema = z.preprocess(
  value => filterHomeRecoveryReasons(value, HOME_RECOVERY_REASONS), homeRecoverySchema);

export const homeRecoveryActionSchema = z.object({ file: homeFileSchema, detectedAt: z.iso.datetime() }).strict();
export type HomeRecoveryAction = z.infer<typeof homeRecoveryActionSchema>;
