import { BINARY_NAMES, productIdentity, scopedNpxCommand, type BinaryName } from '../home/identity.ts';
import { shellQuote as quoteShellWord } from '../core/shell-env.ts';
import type { Home } from '../home/home.ts';
/**
 * The launchers in `<bin>/` and the one-line PATH hook that made `cezar` a command, as
 * `cez install` wrote them. The home migration rewrites both for an existing managed install.
 *
 * A launcher is deliberately dumb: it execs whatever `versions/current` points at. It carries ONE
 * built-in verb, `use`, that flips the link from the shell.
 */

import { closeSync, fchmodSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, win32 } from 'node:path';

import { assertSquawkHomeWriteIsSandboxed } from '../paths.ts';

import { binDir, CURRENT_LINK, PACKAGE_NAME, versionsDir } from './layout.ts';

const PATH_MARKER = '# cezar managed install';
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export function posixLauncher(env: NodeJS.ProcessEnv, home: Home, name?: BinaryName): string {
  // `CEZ_HOME` is honoured at run time too, so a launcher written under the default home keeps
  // working when the user later sets it — the launcher recomputes, it does not bake the path in.
  const homeExpr = home.layout === 'split' ? shellQuote(home.data)
    : home.rootOverride ? shellQuote(home.rootOverride) : '"${CEZ_HOME:-$HOME/.cezar}"';
  const identity = productIdentity();
  const packageName = '$CEZ_PACKAGE';
  const packageChoice = `CEZ_PACKAGE=${shellQuote(identity.npmPackage)}
if [ ! -f "$CEZ_VERSIONS/${CURRENT_LINK}/node_modules/$CEZ_PACKAGE/dist/index.js" ]; then CEZ_PACKAGE=${shellQuote(PACKAGE_NAME)}; fi
`;
  const useTarget = `[ ! -f "$CEZ_VERSIONS/$2/node_modules/${identity.npmPackage}/dist/index.js" ] && `;
  const useNotice = name ? `  NOTICE_ENTRY="$CEZ_VERSIONS/${CURRENT_LINK}/node_modules/${packageName}/dist/use-command-notice.js"
  if [ -f "$NOTICE_ENTRY" ] && command -v node >/dev/null 2>&1; then
    node "$NOTICE_ENTRY" ${quoteShellWord(name)}
  fi
` : '';
  const namedEntry = name ? `NAMED_ENTRY="$CEZ_VERSIONS/${CURRENT_LINK}/node_modules/${packageName}/dist/${name}.js"\nif [ -f "$NAMED_ENTRY" ]; then ENTRY="$NAMED_ENTRY"; fi\n` : '';
  return `#!/bin/sh
# ${identity.command} managed install — do not edit; \`${identity.command} install\` regenerates this file.
CEZ_MANAGED_HOME=${homeExpr}
CEZ_VERSIONS="$CEZ_MANAGED_HOME/versions"
${packageChoice}ENTRY="$CEZ_VERSIONS/${CURRENT_LINK}/node_modules/${packageName}/dist/index.js"

# \`${identity.command} use <id>\` flips the active version without starting cezar — works even when the
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

export function windowsLauncher(env: NodeJS.ProcessEnv, home: Home, name?: BinaryName): string {
  const path = home.layout === 'split' ? win32.join : join;
  const root = path(home.data, 'versions', CURRENT_LINK, 'node_modules');
  const legacy = path(root, ...PACKAGE_NAME.split('/'), 'dist', 'index.js').replaceAll('%', '%%');
  const active = path(root, ...productIdentity().npmPackage.split('/'), 'dist', 'index.js').replaceAll('%', '%%');
  const entry = '%CEZ_ENTRY%';
  const header = `@echo off\r\nrem # ${productIdentity().command} managed install\r\nset "CEZ_ENTRY=${active}"\r\nif not exist "%CEZ_ENTRY%" set "CEZ_ENTRY=${legacy}"\r\n`;
  if (name) {
    const namedEntry = `%CEZ_ENTRY:index.js=${name}.js%`;
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
export function writeLaunchers(env: NodeJS.ProcessEnv = process.env, home: Home, platform: NodeJS.Platform = process.platform): string {
  const dir = binDir(env, home);
  assertSquawkHomeWriteIsSandboxed(dir, env);
  assertSquawkHomeWriteIsSandboxed(versionsDir(env, home), env);
  mkdirSync(dir, { recursive: true });
  mkdirSync(versionsDir(env, home), { recursive: true });
  for (const name of BINARY_NAMES) {
    const path = join(dir, name + (platform === 'win32' ? '.cmd' : ''));
    const contents = platform === 'win32' ? windowsLauncher(env, home, name) : posixLauncher(env, home, name);
    writeLauncher(path, contents, platform);
  }
  return dir;
}

/** The POSIX rc file and its marked PATH line. The home migration replaces exactly this line. */
export function pathHook(dir: string, env: NodeJS.ProcessEnv & { HOME: string }): { file: string; line: string; marker: string } {
  // The user's home comes from `env`, like every other path in this module: a caller (or a
  // test) that points HOME elsewhere must never reach the real shell profile.
  const home = env.HOME;
  const shell = env.SHELL ?? '';
  const rc = shell.endsWith('/zsh') ? '.zshrc' : shell.endsWith('/bash') ? '.bashrc' : '.profile';
  return { file: join(home, rc), line: `export PATH=${shellQuote(dir)}:"$PATH" ${PATH_MARKER}`, marker: PATH_MARKER };
}
