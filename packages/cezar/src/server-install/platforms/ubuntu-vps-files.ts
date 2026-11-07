import { writeFileSync } from 'node:fs';
import type { InstallContext } from '../types.ts';
import { shquote, sudoStep } from '../steps.ts';
import { systemdRemoteEnv } from './service-env.ts';

/** Build a privileged command that writes file content atomically (base64 → no quoting hell). */
function writeRootFileCmd(path: string, content: string, extra = ''): string {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const dir = path.slice(0, path.lastIndexOf('/')) || '/';
  return `install -d -m 0755 ${shquote(dir)} && printf %s ${shquote(b64)} | base64 --decode > ${shquote(path)}${extra ? ` && ${extra}` : ''}`;
}

/**
 * A sudoStep that writes a root-owned file. The command carries the content as
 * base64 (so quoting/newlines survive a copy-paste), which is unreadable — so we
 * always show the DECODED file content in a note first, so the operator can see
 * exactly what will land on disk and knows the base64 is not doing anything
 * hidden.
 */
export function writeFileStep(
  ctx: InstallContext,
  opts: {
    description: string;
    path: string;
    content: string;
    /** Extra shell appended after the write (` && …`). */
    extra?: string;
    verify: (c: InstallContext) => Promise<boolean>;
  },
): Promise<void> {
  return sudoStep(ctx, {
    description: opts.description,
    note: `This writes ${opts.path} with exactly this content:\n\n${opts.content}`,
    command: writeRootFileCmd(opts.path, opts.content, opts.extra),
    verify: opts.verify,
  });
}

/** Redeploy repairs legacy env pins without replacing ExecStart, PATH or operator entries. */
export async function repairUnitEnv(ctx: InstallContext, scope: 'user' | 'system', path: string): Promise<void> {
  const current = await ctx.runner.capture('cat', [path]);
  if (current.code !== 0) return; // The existing restart path diagnoses an absent service.
  const next = systemdRemoteEnv(current.stdout);
  if (next === current.stdout || ctx.dryRun) return;
  if (scope === 'user') writeFileSync(path, next, 'utf8');
  else await sudoStep(ctx, {
    description: 'Add the preferred hosted-mode environment pin to the existing service.',
    // Keep operator env values out of the displayed privileged command.
    command: `sed -i ${shquote('/^Environment=HSQ_REMOTE=/d; /^Environment=CEZ_REMOTE=1$/a Environment=HSQ_REMOTE=1')} ${shquote(path)}`,
    verify: async c => (await c.runner.capture('cat', [path])).stdout === next,
  });
}
