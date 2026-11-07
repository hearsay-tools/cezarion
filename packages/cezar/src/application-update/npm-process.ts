import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, delimiter } from 'node:path';

/** Only npm's declared CLI, reached through the Node toolchain or a canonical npm shim. */
function verifiedCli(candidate: string): string | undefined {
  try {
    const cli = realpathSync(candidate);
    if (basename(cli) !== 'npm-cli.js' || basename(dirname(cli)) !== 'bin' || !statSync(cli).isFile()) return;
    const root = dirname(dirname(cli));
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string; bin?: { npm?: string } };
    if (manifest.name === 'npm' && manifest.bin?.npm === 'bin/npm-cli.js') return cli;
  } catch { /* Missing or unreadable npm means manual updates, never a boot failure. */ }
  return undefined;
}

export interface NpmInvocation { command: string; args: string[] }

function invokeNpmCli(node: string, cli: string): NpmInvocation {
  return { command: node, args: [cli] };
}

function requireVerifiedCli(command: string, node: string): NpmInvocation {
  const cli = verifiedCli(command);
  if (!cli) throw new Error('npm CLI could not be verified');
  return invokeNpmCli(node, cli);
}

function explicitNpmCommand(command: string): NpmInvocation | undefined {
  // Explicit executables are used by embedders and isolated lifecycle fixtures.
  // A Windows command script is never sent to spawn/execFile as an executable.
  if (['npm', 'npm.cmd'].includes(basename(command).toLowerCase())) return undefined;
  if (/\.(cmd|bat)$/i.test(command)) throw new Error('npm command script is unsupported');
  return { command, args: [] };
}

function nodeToolchainCli(node: string, platform: NodeJS.Platform, command: string): string | undefined {
  if (isAbsolute(command)) return undefined;
  const nodeDir = dirname(realpathSync(node));
  return verifiedCli(platform === 'win32'
    ? join(nodeDir, 'node_modules/npm/bin/npm-cli.js')
    : join(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js'));
}

function npmShimCandidates(command: string, platform: NodeJS.Platform, searchPath: string): string[] {
  return isAbsolute(command) ? [command] : searchPath.split(platform === 'win32' ? ';' : delimiter)
    .map(part => part.replace(/^"(.*)"$/, '$1')).filter(isAbsolute)
    .map(part => join(part, platform === 'win32' ? 'npm.cmd' : 'npm'));
}

function verifiedWindowsShimCli(shim: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32' && !/\.cmd$/i.test(shim)) return undefined;
  const cli = verifiedCli(join(dirname(shim), 'node_modules/npm/bin/npm-cli.js'));
  if (!cli) return undefined;
  try {
    const content = readFileSync(shim, 'utf8');
    // npm ships its installer shim; npm install -g npm emits cmd-shim's
    // equivalent. Only their fixed adjacent CLI target is recognized.
    const vendor = readFileSync(join(dirname(cli), 'npm.cmd'), 'utf8');
    if (content === vendor) return cli;
  } catch { /* Fall through to the generated shim's fixed target. */ }
  try {
    const content = readFileSync(shim, 'utf8');
    if (content.includes('SET dp0=%~dp0') && content.includes('"%dp0%\\node_modules\\npm\\bin\\npm-cli.js"')) return cli;
  } catch { /* Keep looking; never execute an unrecognized wrapper. */ }
  return undefined;
}

function resolveNpmFromPath(command: string, node: string, platform: NodeJS.Platform, searchPath: string): NpmInvocation {
  for (const shim of npmShimCandidates(command, platform, searchPath)) {
    const linked = verifiedCli(shim);
    if (linked) return invokeNpmCli(node, linked);
    const cli = verifiedWindowsShimCli(shim, platform);
    if (cli) return invokeNpmCli(node, cli);
  }
  throw new Error('npm CLI could not be verified');
}

export function resolveNpmInvocation(command = 'npm', options: {
  nodeExecutable?: string; platform?: NodeJS.Platform; searchPath?: string;
} = {}): NpmInvocation {
  const node = options.nodeExecutable ?? process.execPath;
  const platform = options.platform ?? process.platform;
  if (basename(command) === 'npm-cli.js') return requireVerifiedCli(command, node);
  const explicit = explicitNpmCommand(command);
  if (explicit) return explicit;
  const toolchain = nodeToolchainCli(node, platform, command);
  if (toolchain) return invokeNpmCli(node, toolchain);
  const searchPath = options.searchPath ?? process.env[Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH'] ?? '';
  return resolveNpmFromPath(command, node, platform, searchPath);
}

/** Discovery and both mutating phases use the exact same shell-free invocation. */
export function readNpmConfiguration(command = 'npm'): { npmBin: string; prefix: string; cache: string } | undefined {
  try {
    const invocation = resolveNpmInvocation(command);
    const value = (args: string[]) => execFileSync(invocation.command, [...invocation.args, ...args], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], shell: false,
    }).trim();
    const prefix = value(['prefix', '-g']);
    const cache = value(['config', 'get', 'cache']);
    return prefix && cache ? { npmBin: invocation.args[0] ?? invocation.command, prefix, cache } : undefined;
  } catch { return undefined; }
}

/** A lock abort is complete only after the npm process has actually exited. */
export async function runOwnedNpm(command: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('update lock ownership changed');
  const invocation = resolveNpmInvocation(command);
  const child = spawn(invocation.command, [...invocation.args, ...args], { env, stdio: 'ignore', shell: false });
  await new Promise<void>((resolve, reject) => {
    let cancelled = false;
    let timedOut = false;
    let spawnError: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), 2_000);
    };
    const deadline = setTimeout(() => { timedOut = true; cancel(); }, 120_000);
    const onAbort = () => cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) cancel();
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code) => {
      clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(new Error('update lock ownership changed'));
      else if (spawnError) reject(new Error('npm could not start'));
      else if (timedOut) reject(new Error('npm operation timed out'));
      else if (cancelled) reject(new Error('npm operation cancelled'));
      else if (code !== 0) reject(new Error('npm operation failed'));
      else resolve();
    });
  });
}
