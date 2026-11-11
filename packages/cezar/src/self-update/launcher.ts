import { BINARY_NAMES, productIdentity, scopedNpxCommand, type BinaryName } from '../home/identity.ts';
import { shellQuote as quoteShellWord } from '../core/shell-env.ts';
import type { Home } from '../home/home.ts';
/**
 * The launchers in `~/.cezar/bin/` and the one-line PATH hook that makes `cezar` a command.
 *
 * A launcher is deliberately dumb: it execs whatever `versions/current` points at, so an update
 * is a symlink flip and the launcher is never rewritten. It carries ONE built-in verb, `use`,
 * that flips the link from the shell — the escape hatch for a downgrade into a version that
 * predates the cockpit's update dialog (this PoC's own situation).
 */

import { appendFileSync, closeSync, fchmodSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';

import { assertCezarHomeWriteIsSandboxed } from '../paths.ts';

import { activate, binDir, CURRENT_LINK, PACKAGE_NAME, versionsDir } from './layout.ts';

const PATH_MARKER = '# cezar managed install';
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export function posixLauncher(env: NodeJS.ProcessEnv, home: Home, name?: BinaryName, rebrand = productIdentity().rebrand): string {
  // `CEZ_HOME` is honoured at run time too, so a launcher written under the default home keeps
  // working when the user later sets it — the launcher recomputes, it does not bake the path in.
  const homeExpr = home.layout === 'split' ? shellQuote(home.data)
    : home.rootOverride ? shellQuote(home.rootOverride) : '"${CEZ_HOME:-$HOME/.cezar}"';
  const identity = productIdentity(rebrand);
  const packageName = rebrand ? '$CEZ_PACKAGE' : PACKAGE_NAME;
  const packageChoice = rebrand ? `CEZ_PACKAGE=${shellQuote(identity.npmPackage)}
if [ ! -f "$CEZ_VERSIONS/${CURRENT_LINK}/node_modules/$CEZ_PACKAGE/dist/index.js" ]; then CEZ_PACKAGE=${shellQuote(PACKAGE_NAME)}; fi
` : '';
  const useTarget = rebrand ? `[ ! -f "$CEZ_VERSIONS/$2/node_modules/${identity.npmPackage}/dist/index.js" ] && ` : '';
  const useNotice = name ? `  NOTICE_ENTRY="$CEZ_VERSIONS/${CURRENT_LINK}/node_modules/${packageName}/dist/use-command-notice.js"
  if [ -f "$NOTICE_ENTRY" ] && command -v node >/dev/null 2>&1; then
    node "$NOTICE_ENTRY" ${quoteShellWord(name)}
  fi
` : '';
  const namedEntry = name ? `NAMED_ENTRY="$CEZ_VERSIONS/${CURRENT_LINK}/node_modules/${packageName}/dist/${name}.js"\nif [ -f "$NAMED_ENTRY" ]; then ENTRY="$NAMED_ENTRY"; fi\n` : '';
  return `#!/bin/sh
${rebrand ? `# ${identity.command} managed install` : PATH_MARKER} — do not edit; \`${rebrand ? identity.command : 'cez'} install\` regenerates this file.
CEZ_MANAGED_HOME=${homeExpr}
CEZ_VERSIONS="$CEZ_MANAGED_HOME/versions"
${packageChoice}ENTRY="$CEZ_VERSIONS/${CURRENT_LINK}/node_modules/${packageName}/dist/index.js"

# \`${rebrand ? identity.command : 'cezar'} use <id>\` flips the active version without starting cezar — works even when the
# active version has no idea what a managed install is.
if [ "$1" = "use" ] && [ -n "$2" ]; then
${useNotice}  if ${useTarget}[ ! -f "$CEZ_VERSIONS/$2/node_modules/${PACKAGE_NAME}/dist/index.js" ]; then
    echo "cezar: version '$2' is not installed under $CEZ_VERSIONS" >&2
    echo "installed:" >&2
    ls -1 "$CEZ_VERSIONS" 2>/dev/null | grep -v '^${CURRENT_LINK}$' | grep -v '^\\.' | sed 's/^/  /' >&2
    exit 1
  fi
  # \`ln -sfn\` replaces the link itself; a \`mv\` onto a symlink-to-directory would move INTO it.
  ln -sfn "$2" "$CEZ_VERSIONS/${CURRENT_LINK}" || exit 1
  echo "cezar: now using $2"
  exit 0
fi

if [ ! -f "$ENTRY" ]; then
  echo "cezar: no active version under $CEZ_VERSIONS — run: ${scopedNpxCommand(identity)} install" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "cezar: node is not on PATH (Node 20+ is required)" >&2
  exit 1
fi
${namedEntry}exec node "$ENTRY" "$@"
`;
}

export function windowsLauncher(env: NodeJS.ProcessEnv, home: Home, name?: BinaryName, rebrand = productIdentity().rebrand): string {
  const path = home.layout === 'split' ? win32.join : join;
  const root = path(home.data, 'versions', CURRENT_LINK, 'node_modules');
  const legacy = path(root, ...PACKAGE_NAME.split('/'), 'dist', 'index.js').replaceAll('%', '%%');
  const active = path(root, ...productIdentity(rebrand).npmPackage.split('/'), 'dist', 'index.js').replaceAll('%', '%%');
  const entry = rebrand ? '%CEZ_ENTRY%' : legacy;
  const header = rebrand
    ? `@echo off\r\nrem # ${productIdentity(rebrand).command} managed install\r\nset "CEZ_ENTRY=${active}"\r\nif not exist "%CEZ_ENTRY%" set "CEZ_ENTRY=${legacy}"\r\n`
    : `@echo off\r\nrem ${PATH_MARKER}\r\n`;
  if (name) {
    const namedEntry = rebrand ? `%CEZ_ENTRY:index.js=${name}.js%` : entry.replace(/index\.js$/, `${name}.js`);
    return `${header}if exist "${namedEntry}" (\r\n  node "${namedEntry}" %*\r\n) else (\r\n  node "${entry}" %*\r\n)\r\n`;
  }
  return `${header}node "${entry}" %*\r\n`;
}

/** Match the old writer's final mode: POSIX executable; Windows existing mode or umask. */
function launcherMode(path: string, platform: NodeJS.Platform): number {
  if (platform !== 'win32') return 0o755;
  try { return statSync(path).mode & 0o777; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return 0o666 & ~process.umask();
  }
}

/** Never truncate a live command. A locked Windows destination must fail closed. */
function writeLauncher(path: string, contents: string, platform: NodeJS.Platform): void {
  const mode = launcherMode(path, platform);
  const temp = `${path}.${randomUUID()}.tmp`;
  // Exclusive open establishes ownership before the cleanup scope. It cannot remove a foreign file.
  const fd = openSync(temp, 'wx', mode);
  try {
    try {
      writeFileSync(fd, contents);
      fchmodSync(fd, mode);
    } finally { closeSync(fd); }
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

/** Write each supported binary launcher. Returns the bin directory. */
export function writeLaunchers(env: NodeJS.ProcessEnv = process.env, home: Home, rebrand = productIdentity().rebrand, platform: NodeJS.Platform = process.platform): string {
  const dir = binDir(env, home);
  assertCezarHomeWriteIsSandboxed(dir, env);
  assertCezarHomeWriteIsSandboxed(versionsDir(env, home), env);
  mkdirSync(dir, { recursive: true });
  mkdirSync(versionsDir(env, home), { recursive: true });
  for (const name of BINARY_NAMES) {
    const path = join(dir, name + (platform === 'win32' ? '.cmd' : ''));
    const contents = platform === 'win32' ? windowsLauncher(env, home, name, rebrand) : posixLauncher(env, home, name, rebrand);
    writeLauncher(path, contents, platform);
  }
  return dir;
}

/** Refresh fixed legacy launch paths before selecting a renamed managed tree.
 * With the switch off, preserve activation order and leave launcher writes to the caller. */
export function activateManaged(id: string, env: NodeJS.ProcessEnv, home: Home, rebrand = productIdentity().rebrand, platform: NodeJS.Platform = process.platform): void {
  if (rebrand) writeLaunchers(env, home, rebrand, platform);
  activate(id, env, home, rebrand);
}

/** Whether `dir` is already on the caller's PATH. */
export function isOnPath(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const entries = (env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
  return entries.some((entry) => entry === dir || entry === dir.replace(homedir(), '~'));
}

export interface PathHookResult {
  /** The rc file the hook was written to, or null when nothing was written. */
  file: string | null;
  /** The line to add by hand when `file` is null. */
  line: string;
  alreadyPresent: boolean;
}

/** The POSIX rc file and its marked PATH line. The home migration replaces exactly this line. */
export function pathHook(dir: string, env: NodeJS.ProcessEnv = process.env): { file: string; line: string; marker: string } {
  // The user's home comes from `env`, like every other path in this module: a caller (or a
  // test) that points HOME elsewhere must never reach the real shell profile.
  const home = env.HOME || homedir();
  const shell = env.SHELL ?? '';
  const rc = shell.endsWith('/zsh') ? '.zshrc' : shell.endsWith('/bash') ? '.bashrc' : '.profile';
  return { file: join(home, rc), line: `export PATH=${shellQuote(dir)}:"$PATH" ${PATH_MARKER}`, marker: PATH_MARKER };
}

/**
 * Add `~/.cezar/bin` to PATH for future shells by appending one marked line to the shell's rc
 * file (`.zshrc`, `.bashrc`, or `.profile` for anything else). Idempotent: the marker is what a
 * second run looks for. Windows users are told the line; the PoC does not touch the registry.
 */
export function ensurePathHook(dir: string, env: NodeJS.ProcessEnv = process.env): PathHookResult {
  if (process.platform === 'win32') return { file: null, line: `setx PATH "%PATH%;${dir}"`, alreadyPresent: false };
  const { file, line } = pathHook(dir, env);
  let current = '';
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    // No rc file yet: the append below creates it.
  }
  if (current.includes(PATH_MARKER)) return { file, line, alreadyPresent: true };
  appendFileSync(file, `\n${line}\n`);
  return { file, line, alreadyPresent: false };
}
