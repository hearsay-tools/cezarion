import { BINARY_NAMES } from '../../home/identity.ts';
import { ownedNpxPackage } from '../npx-cache.ts';
import { shellQuote } from '../../core/shell-env.ts';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InstallContext, StepArtifact } from '../types.ts';
import { StepAborted } from '../steps.ts';

/** Reject symlinks and directories before any host plist mutation. */
export function readLaunchdPlist(path: string): string {
  if (!lstatSync(path).isFile()) throw new StepAborted(`Refusing non-regular plist: ${path}`);
  return readFileSync(path, 'utf8');
}

/** Only the exact installer launch forms establish ownership without a ledger. */
function isOurLauncher(xml: string): boolean {
  const inner = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '';
  const args = [...inner.matchAll(/<string>([\s\S]*?)<\/string>/g)]
    .map((m) => m[1]!.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
  const serve = args.indexOf('serve');
  if (serve < 1) return false;
  const command = args.slice(0, serve);
  if (basename(command[0]!) === 'npx') {
    const form = command.length === 3 || (command.length === 5 && command[2] === '-p');
    return form && command[1] === '--yes' && ownedNpxPackage(command.map(shellQuote).join(' ')) !== undefined;
  }
  if (command.length !== 2 || !/^node(?:\.exe)?$/.test(basename(command[0]!))) return false;
  const entry = command[1]!;
  const ownEntry = resolve(fileURLToPath(new URL('../../../dist/index.js', import.meta.url)));
  return entry === ownEntry || BINARY_NAMES.some(name => basename(entry) === name || entry === resolve(ownEntry, '..', `${name}.js`));
}

function sameAgent(a: StepArtifact | undefined, b: StepArtifact): boolean {
  return a?.kind === 'owned' && a.type === 'launchd' && a.name === b.name && a.path === b.path;
}

export function ownsLaunchdPlist(ctx: InstallContext, artifact: StepArtifact, xml: string): boolean {
  const recorded = Object.values(ctx.state.steps).some((step) =>
    step.created?.artifacts.some((a) => sameAgent(a, artifact)));
  const cockpit = artifact.name === 'ai.cezar.cockpit' || artifact.name === 'tools.hearsay.squawk.cockpit';
  const actualLabel = xml.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  return recorded || (cockpit && actualLabel === artifact.name && isOurLauncher(xml));
}

/** One ownership gate for install, migration and rollback writes. Undefined means absent.
 * A selected identity is the single agent the step's check/ledger already chose.
 * Expected bytes protect resumable rollback and cleanup from changed plists. */
export function guardLaunchdWrite(
  ctx: InstallContext,
  target: StepArtifact,
  proof: { selected?: StepArtifact; expectedXml?: string } = {},
): string | undefined {
  let xml: string;
  try {
    xml = readLaunchdPlist(target.path!);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (proof.expectedXml !== undefined && xml !== proof.expectedXml) throw new StepAborted(`Destination plist changed: ${target.path}`);
  if (!sameAgent(proof.selected, target) && !ownsLaunchdPlist(ctx, target, xml)) {
    throw new StepAborted(`Destination already exists and is not owned: ${target.path}`);
  }
  return xml;
}
