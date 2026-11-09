import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const manifest = directory => JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
const posix = file => file.split(sep).join('/');
const guardCommand = 'node scripts/check-typecheck-coverage.mjs';

/** Follow the commands actually invoked, not every tsconfig found on disk.
 * This deliberately accepts only our simple npm/tsc command grammar. Unknown
 * shell syntax fails closed rather than silently declaring a tree checked. */
export function typecheckProjects(root) {
  const workspace = new Map((manifest(root).workspaces ?? []).map(directory => [manifest(join(root, directory)).name, directory]));
  const projects = new Map();
  const visit = (directory, name, stack = []) => {
    const key = `${directory}:${name}`;
    if (stack.includes(key)) throw new Error(`Recursive typecheck script: ${key}`);
    const command = manifest(join(root, directory)).scripts?.[name];
    if (!command) throw new Error(`Missing typecheck script: ${key}`);
    for (const part of command.split(/\s*&&\s*/)) {
      if (directory === '.' && part === guardCommand) continue;
      const npm = /^npm run ([\w:-]+)(?: -w ([\w@/.-]+))?$/.exec(part);
      if (npm) {
        const target = npm[2] === undefined ? directory : workspace.get(npm[2]);
        if (target === undefined) throw new Error(`Unknown typecheck workspace: ${npm[2]}`);
        visit(target, npm[1], [...stack, key]);
        continue;
      }
      const tsc = /^tsc --noEmit(?: -p ([\w./-]+))?$/.exec(part);
      if (!tsc) throw new Error(`Unsupported typecheck command: ${part}`);
      const config = posix(relative(root, resolve(root, directory, tsc[1] ?? 'tsconfig.json')));
      projects.set(config, { config });
    }
  };
  visit('.', 'typecheck');
  // Packaged probes are checked after build against emitted declarations. Keep
  // that phase separate; listing its inputs neither builds nor typechecks it.
  if (manifest(root).scripts?.['typecheck:package']) visit('.', 'typecheck:package');
  return [...projects.values()];
}

export function checkCoverage(root, compiler = join(root, 'node_modules/typescript/bin/tsc')) {
  const covered = new Set();
  for (const { config } of typecheckProjects(root)) {
    const listing = execFileSync(process.execPath, [compiler, '--listFilesOnly', '-p', config], {
      cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    for (const file of listing.split(/\r?\n/)) if (file) covered.add(resolve(root, file));
  }
  // Include untracked work so the guard works before the first commit. Respect
  // ignores, but keep tracked files even when an ignore pattern later matches.
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).split('\0');
  return [...new Set(files)].filter(file => /\.(?:ts|tsx|mts|cts)$/.test(file)
    && !/\.d\.(?:ts|mts|cts)$/.test(file) && existsSync(join(root, file))
    && !covered.has(resolve(root, file))).sort();
}

export function main(root) {
  const missing = checkCoverage(root);
  if (missing.length) {
    console.error(`TypeScript files outside the invoked typechecks:\n${missing.join('\n')}`);
    return 1;
  }
  console.log('Typecheck coverage: every executable TypeScript file is reached.');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(resolve(dirname(fileURLToPath(import.meta.url)), '..')); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
