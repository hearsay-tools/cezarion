import { isAbsolute } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { z } from 'zod';
import { profileEnv, supportsProfiles } from '../core/agent-profiles.ts';
import type { ResolvedAgentProfile } from '../workspace/agent-profiles.ts';
import { agentHomePaths, claudeStateFilePath } from '../paths.ts';

const absolutePathSchema = z.string().min(1).max(4096).refine(isAbsolute).refine(path => !/[\u0000-\u001f\u007f]/.test(path));

/** Internal durable evidence, never a public environment override or credential snapshot. */
export const workerAccountBindingSchema = z.object({
  provider: z.enum(['claude', 'codex', 'opencode', 'pi']),
  profileId: z.string().min(1).max(64),
  homePath: absolutePathSchema.optional(),
  // Identical config directories can have different state/login files depending on invocation.
  claudeLayout: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('native'), statePath: absolutePathSchema }).strict(),
    z.object({ kind: z.literal('relocated') }).strict(),
  ]).optional(),
}).strict().refine(binding => supportsProfiles(binding.provider)
  ? binding.homePath !== undefined
  : binding.homePath === undefined && binding.profileId === 'default')
  .refine(binding => binding.provider === 'claude'
    ? binding.claudeLayout !== undefined && (binding.claudeLayout.kind !== 'native' || binding.profileId === 'default')
    : binding.claudeLayout === undefined);
export type WorkerAccountBinding = z.infer<typeof workerAccountBindingSchema>;

export const acceptedWorkerIdentitySchema = z.object({
  kind: z.literal('accepted'),
  account: workerAccountBindingSchema,
  model: z.string().min(1).max(512).optional(),
  effort: z.string().min(1).max(128).optional(),
}).strict();
export type AcceptedWorkerIdentity = z.infer<typeof acceptedWorkerIdentitySchema>;
export const workerExecutionIdentitySchema = z.union([
  acceptedWorkerIdentitySchema,
  // Only explicitly written by the internal owned-creation primitive. Absence never means legacy.
  z.object({ kind: z.literal('internal') }).strict(),
]);
export type WorkerExecutionIdentity = z.infer<typeof workerExecutionIdentitySchema>;
export class WorkerIdentityError extends Error {}

export function captureWorkerAccount(profile: ResolvedAgentProfile, env: NodeJS.ProcessEnv = process.env): WorkerAccountBinding | undefined {
  if (!supportsProfiles(profile.provider)) return { provider: profile.provider, profileId: 'default' };
  // Bind an existing symlink to its actual home. A native first-run home may not exist yet.
  const claudeHome = agentHomePaths(env).claude;
  let homePath = profile.provider === 'claude' ? claudeHome : profile.path;
  try { homePath = realpathSync(homePath); } catch { /* The owned consumer still requires it to exist. */ }
  const claudeLayout = profile.provider !== 'claude' ? undefined
    : env.CLAUDE_CONFIG_DIR?.trim() ? { kind: 'relocated' as const }
    : { kind: 'native' as const, statePath: claudeStateFilePath(claudeHome, env) };
  const parsed = workerAccountBindingSchema.safeParse({ provider: profile.provider, profileId: profile.id, homePath,
    ...(claudeLayout === undefined ? {} : { claudeLayout }) });
  return parsed.success ? parsed.data : undefined;
}

export function boundWorkerAccountEnv(binding: WorkerAccountBinding, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (binding.homePath === undefined) return {};
  try {
    if (!statSync(binding.homePath).isDirectory() || realpathSync(binding.homePath) !== binding.homePath) throw new Error();
  } catch { throw new WorkerIdentityError('Accepted worker account identity is unavailable'); }
  if (binding.claudeLayout?.kind === 'native') {
    const nativeHome = agentHomePaths(env).claude;
    try {
      if (env.CLAUDE_CONFIG_DIR?.trim() || claudeStateFilePath(nativeHome, env) !== binding.claudeLayout.statePath ||
          realpathSync(nativeHome) !== binding.homePath) throw new Error();
    } catch { throw new WorkerIdentityError('Accepted native Claude account layout is unavailable'); }
    return {};
  }
  return profileEnv(binding.provider, binding.homePath);
}
