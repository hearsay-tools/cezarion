import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, realpathSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suite = 'packages/cezar/test/e2e';

export function selectTests(repo, args, paths = { resolve, relative, isAbsolute, sep, realpath: realpathSync, exists: existsSync }) {
  const directory = join(repo, suite);
  const files = args.length ? args : readdirSync(directory).filter(name => name.endsWith('.test.ts')).sort().map(name => `${suite}/${name}`);
  return files.map(file => {
    const absolute = paths.resolve(repo, file);
    const lexical = paths.relative(directory, absolute);
    const within = paths.relative(paths.realpath(directory), paths.exists(absolute) ? paths.realpath(absolute) : absolute);
    if (paths.isAbsolute(lexical) || paths.isAbsolute(within) || lexical.startsWith('..') || within.startsWith(`..${paths.sep}`) || within === '..' || !within.endsWith('.test.ts') || !paths.exists(absolute)) {
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
  const inputs = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'README.md', 'scripts/test-package.mjs'];
  inputs.push(...['.env', '.env.local', '.env.production', '.env.production.local'].map(file => `packages/web/${file}`));
  for (const name of ['cezar', 'contract', 'api-client', 'web']) {
    const base = `packages/${name}`;
    inputs.push(`${base}/src`, `${base}/scripts`, `${base}/public`);
    if (existsSync(join(repo, base))) {
      inputs.push(...readdirSync(join(repo, base)).filter(file => /(?:\.json|\.html|config\.[cm]?[jt]s)$/.test(file)).map(file => `${base}/${file}`));
    }
  }
  return inputs.flatMap(path => treeFiles(join(repo, path)));
}

const outputRoots = ['packages/cezar/dist', 'packages/cezar/web/dist', 'packages/cezar/README.md'];
const requiredOutputs = ['packages/cezar/dist/index.js', 'packages/cezar/dist/contract/index.js', 'packages/cezar/web/dist/index.html', 'packages/cezar/README.md'];
const stampPath = repo => join(repo, 'node_modules/.cache/cezar-test-package/stamp.json');
const digest = value => createHash('sha256').update(value).digest('hex');

function fingerprints(repo, env) {
  const inputs = buildInputs(repo).sort().map(file => [relative(repo, file), digest(readFileSync(file))]);
  // Vite exposes VITE_* and NODE_ENV to the bundle. CEZ_API_PORT is read by
  // vite.config.ts. npm_execpath only chooses the npm binary in check:pack.
  // Hash values so the stamp never stores URLs or other environment contents.
  const environment = ['NODE_ENV', 'CEZ_API_PORT', ...Object.keys(env).filter(key => key.startsWith('VITE_'))]
    .sort().map(key => [key, env[key] ?? null]);
  return { inputs: digest(JSON.stringify(inputs)), environment: digest(JSON.stringify(environment)) };
}

export function recordBuild(repo, env = process.env) {
  if (requiredOutputs.some(file => !existsSync(join(repo, file)))) throw new Error('Cannot stamp an incomplete build');
  const outputs = outputRoots.flatMap(path => treeFiles(join(repo, path))).map(file => relative(repo, file)).sort();
  const stamp = { ...fingerprints(repo, env), outputs };
  mkdirSync(dirname(stampPath(repo)), { recursive: true });
  writeFileSync(stampPath(repo), JSON.stringify(stamp));
}

export function needsBuild(repo, env = process.env) {
  try {
    const stamp = JSON.parse(readFileSync(stampPath(repo), 'utf8'));
    const current = fingerprints(repo, env);
    return stamp.inputs !== current.inputs || stamp.environment !== current.environment ||
      !Array.isArray(stamp.outputs) || stamp.outputs.length === 0 ||
      stamp.outputs.some(file => typeof file !== 'string' || !existsSync(join(repo, file))) ||
      requiredOutputs.some(file => !existsSync(join(repo, file)));
  } catch {
    return true;
  }
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
  try {
    if (process.argv[2] === '--record-build-stamp') recordBuild(root);
    else main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
