import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suite = 'packages/cezar/test/e2e';

export function selectTests(repo, args) {
  const directory = join(repo, suite);
  const files = args.length ? args : readdirSync(directory).filter(name => name.endsWith('.test.ts')).sort().map(name => `${suite}/${name}`);
  return files.map(file => {
    const absolute = resolve(repo, file);
    const within = relative(realpathSync(directory), existsSync(absolute) ? realpathSync(absolute) : absolute);
    if (relative(directory, absolute).startsWith('..') || within.startsWith(`..${sep}`) || within === '..' || !within.endsWith('.test.ts') || !existsSync(absolute)) {
      throw new Error(`Packaged test path must name a .test.ts file inside ${suite}/: ${file}`);
    }
    return relative(join(repo, 'packages/cezar'), absolute);
  });
}

function treeFiles(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap(name => treeFiles(join(path, name)));
}

// Include build hooks, compiler/Vite configuration, workspace metadata and local
// dependencies. The tarball is packed afresh by the tests, not cached here.
export function buildInputs(repo) {
  const inputs = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'README.md'];
  for (const name of ['cezar', 'contract', 'api-client', 'web']) {
    const base = `packages/${name}`;
    inputs.push(`${base}/src`, `${base}/scripts`, `${base}/public`);
    if (existsSync(join(repo, base))) {
      inputs.push(...readdirSync(join(repo, base)).filter(file => /(?:\.json|\.html|config\.[cm]?[jt]s)$/.test(file)).map(file => `${base}/${file}`));
    }
  }
  return inputs.flatMap(path => treeFiles(join(repo, path)));
}

export function needsBuild(repo) {
  const required = ['packages/cezar/dist/index.js', 'packages/cezar/dist/contract/index.js', 'packages/cezar/web/dist/index.html', 'packages/cezar/README.md'];
  if (required.some(path => !existsSync(join(repo, path)))) return true;
  const outputs = ['packages/cezar/dist', 'packages/cezar/web/dist', 'packages/cezar/README.md'].flatMap(path => treeFiles(join(repo, path)));
  const oldest = Math.min(...outputs.map(path => statSync(path).mtimeMs));
  return buildInputs(repo).some(path => statSync(path).mtimeMs > oldest);
}

export function main(args, { repo = root, platform = process.platform, spawn = spawnSync, log = console.log } = {}) {
  const files = selectTests(repo, args);
  const run = (command, argv, cwd, shell = false) => {
    const result = spawn(command, argv, { cwd, stdio: 'inherit', shell });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  };
  if (needsBuild(repo)) {
    log('Packaged tests: build outputs are missing or stale; running npm run build.');
    run(platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], repo, platform === 'win32');
  } else {
    log('Packaged tests: build outputs are fresh; skipping build.');
  }
  run(process.execPath, ['--import', '../../scripts/test-git-env.mjs', '--import', 'tsx', '--test', ...files], join(repo, 'packages/cezar'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
