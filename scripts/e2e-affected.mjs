#!/usr/bin/env node
// Runs the cockpit browser specs that this checkout's changes reach (hearsay-tools/cezarion#1816).
// Iteration feedback only: CI still runs every spec.
//
// The spec map, built on each push to main by .github/workflows/e2e-spec-map.yml, links each
// cockpit source file to the specs that ran it in a real browser. The selector diffs the working
// tree against the map's own commit, so a map older than the branch base still answers for every
// change since. A change the map cannot answer for (server code, styles, the test environment)
// selects every spec. packages/web/e2e/README.md § Choosing specs for a change has the rules.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { isDocsPath } = createRequire(import.meta.url)('../.github/scripts/change-surface.cjs');

export const SPEC_DIR = 'packages/web/e2e';
const WORKFLOW = 'e2e-spec-map.yml';
const ARTIFACT = 'e2e-spec-map';
const CACHE_DIR = '.ai/qa/e2e-spec-map';
const DURATIONS = '.github/cockpit-test-durations.json';
const LOG = '[e2e:affected]';

const usage = 'Use --plan, --map=<file>, or arguments for npm run test:e2e.';

export function parseOptions(argv) {
  const options = { plan: false, map: undefined, forward: [] };
  for (const arg of argv) {
    if (arg === '--plan') options.plan = true;
    else if (arg.startsWith('--map=') && arg.length > 6) options.map = arg.slice(6);
    else if (arg.startsWith('--map')) throw new Error(`--map takes a file: --map=<file>. ${usage}`);
    else options.forward.push(arg);
  }
  return options;
}

// The map --------------------------------------------------------------------------------------

const SPEC_PATH = /^packages\/web\/e2e\/[^/]+\.e2e\.ts$/;
const isIndexList = (value, size) => Array.isArray(value)
  && value.every(index => Number.isInteger(index) && index >= 0 && index < size);

/** Why `value` is not a version 1 spec map, or null when it is one. */
export function mapProblem(value) {
  if (value?.version !== 1) return 'its version is not 1';
  if (typeof value.commit !== 'string' || !/^[0-9a-f]{40}$/.test(value.commit)) return 'it names no full commit id';
  if (!Array.isArray(value.specs) || !value.specs.every(spec => SPEC_PATH.test(spec))) return 'its specs are not spec paths';
  if (!Array.isArray(value.incomplete) || !value.incomplete.every(spec => value.specs.includes(spec))) {
    return 'its incomplete specs are not in its spec list';
  }
  if (typeof value.sources !== 'object' || value.sources === null) return 'it has no sources';
  const bad = Object.entries(value.sources).find(([, indexes]) => !isIndexList(indexes, value.specs.length));
  return bad ? `its entry for ${bad[0]} is not a list of spec indexes` : null;
}

export function readMap(file) {
  let value;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { error: `cannot read the spec map at ${file}: ${firstLine(error)}` };
  }
  const problem = mapProblem(value);
  return problem ? { error: `the spec map at ${file} is not valid: ${problem}` } : { map: value, file };
}

function firstLine(error) {
  return String(error?.stderr || error?.message || error).trim().split('\n')[0];
}

function cachedMap(root, why) {
  const dir = join(root, CACHE_DIR);
  const runs = existsSync(dir) ? readdirSync(dir).filter(name => /^\d+$/.test(name)) : [];
  const newest = runs.sort((a, b) => Number(b) - Number(a)).find(id => existsSync(join(dir, id, `${ARTIFACT}.json`)));
  if (!newest) return { error: `no spec map: ${why}` };
  console.warn(`${LOG} ${why}; using the map cached from run ${newest}.`);
  return readMap(join(dir, newest, `${ARTIFACT}.json`));
}

/**
 * The map from the newest successful refresh on main, downloaded once into `.ai/qa/e2e-spec-map/`.
 * Without `gh`, a network or a successful run, the newest cached map; without one, an error.
 */
export function latestMap(root, run) {
  let runs;
  try {
    runs = JSON.parse(run('gh', [
      'run', 'list', '--workflow', WORKFLOW, '--branch', 'main', '--status', 'success',
      '--limit', '20', '--json', 'databaseId,event',
    ]));
  } catch (error) {
    return cachedMap(root, `gh cannot list the ${WORKFLOW} runs (${firstLine(error)})`);
  }
  // A pull request run from a branch named main maps that branch, not main.
  const latest = runs.find(({ event }) => event === 'push' || event === 'workflow_dispatch');
  if (!latest) return cachedMap(root, `${WORKFLOW} has no successful run on main`);
  const dir = join(root, CACHE_DIR, String(latest.databaseId));
  const file = join(dir, `${ARTIFACT}.json`);
  if (!existsSync(file)) {
    try {
      run('gh', ['run', 'download', String(latest.databaseId), '--name', ARTIFACT, '--dir', dir]);
    } catch (error) {
      return cachedMap(root, `gh cannot download the map of run ${latest.databaseId} (${firstLine(error)})`);
    }
  }
  return readMap(file);
}

// What the specs read outside the browser -----------------------------------------------------

const CODE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const ALIASES = [
  ['@open-mercato/cezar-api-client', 'packages/api-client/src'],
  ['@open-mercato/cezar-contract', 'packages/contract/src'],
];

function aliasBase(from, literal) {
  if (literal.startsWith('@/')) return from.startsWith('packages/web/src/') ? posix.join('packages/web/src', literal.slice(2)) : null;
  for (const [name, dir] of ALIASES) {
    if (literal === name) return `${dir}/index`;
    if (literal.startsWith(`${name}/`)) return posix.join(dir, literal.slice(name.length + 1));
  }
  return null;
}

/**
 * The repository file or directory a string literal in `from` names: an import specifier, or a
 * path such as `'fixtures/thread-run.ndjson'` that a spec resolves against its own directory.
 * A directory counts only below `from`'s own directory: `resolve(import.meta.dirname, '../../..')`
 * names the repository root, not something the file reads.
 */
export function resolveLiteral(root, from, literal) {
  if (!/^[\w@.~/-]+$/.test(literal) || !/[\w~-]/.test(literal) || literal.startsWith('/')) return null;
  const base = aliasBase(from, literal) ?? posix.join(posix.dirname(from), literal);
  if (base.startsWith('../') || base.split('/').includes('node_modules')) return null;
  const stem = base.replace(/\.(?:m?js|jsx)$/, '');
  for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    const path = join(root, candidate);
    if (!existsSync(path)) continue;
    if (!statSync(path).isDirectory()) return candidate;
    if (candidate.startsWith(`${posix.dirname(from)}/`)) return `${candidate}/`;
  }
  return null;
}

/** String literals in a code file, after its comments are removed. */
export function stringLiterals(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
  return [...code.matchAll(/(['"`])((?:(?!\1)[^\\\n$])+)\1/g)].map(match => match[2]);
}

/** Every repository file or directory `start` reaches through the literals of its code files. */
function closure(root, start, cache) {
  const reached = new Set();
  const pending = [start];
  while (pending.length > 0) {
    const file = pending.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    if (!CODE.test(file)) continue;
    if (!cache.has(file)) {
      const text = existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : '';
      cache.set(file, stringLiterals(text).map(literal => resolveLiteral(root, file, literal)).filter(Boolean));
    }
    pending.push(...cache.get(file));
  }
  return reached;
}

/**
 * What the browser suite reads in Node: `setup` is what its configuration loads for every spec,
 * `specs` what each spec loads itself, the spec file included.
 */
export function referenceGraph(root, specFiles) {
  const cache = new Map();
  return {
    setup: closure(root, `${SPEC_DIR}/vitest.config.ts`, cache),
    specs: new Map(specFiles.map(spec => [spec, closure(root, spec, cache)])),
  };
}

const reaches = (set, file) => set.has(file) || [...set].some(entry => entry.endsWith('/') && file.startsWith(entry));

// Selection ------------------------------------------------------------------------------------

const UNIT_TEST = /\.(?:test|testkit)\.[cm]?[jt]sx?$|^packages\/[^/]+\/src\/test\/|\/__snapshots__\//;
const BUNDLED = /^packages\/(?:web|api-client)\/src\/.+\.tsx?$/;
const EVERY_SPEC = [
  [/^packages\/cezar\//, 'server or CLI code: the map holds cockpit code only'],
  [/^packages\/contract\//, 'the contract, which the server reads too'],
  [/^packages\/web\//, 'a cockpit build input or a style: the map holds JavaScript only'],
  [/^\.ai\/scripts\//, 'the test environment'],
  [/^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/, 'the dependencies'],
  [/(?:)/, 'the map does not cover this path'],
];

const none = reason => ({ specs: [], reason });
const every = reason => ({ specs: null, reason });

function mappedSpecs(file, map, readers) {
  const indexes = map.sources[file];
  if (indexes === undefined) return { specs: readers, reason: `not in the bundle at ${map.commit.slice(0, 8)}`, mapped: true };
  const specs = [...new Set([...indexes.map(index => map.specs[index]), ...readers])];
  return { specs, reason: specs.length > 0 ? 'the specs that run it' : 'no spec runs it', mapped: true };
}

function e2eFileSpecs(file, readers) {
  if (readers.length > 0) return { specs: readers, reason: 'the specs that load it' };
  if (file.startsWith(`${SPEC_DIR}/spec-map/`)) return none('spec-map tooling, which npm run test:e2e never loads');
  if (file.endsWith('.e2e.ts')) return none('a removed spec');
  return every('an e2e file no spec names: a spec may read it through a computed path');
}

/** The specs one changed file selects: a list, or null for every spec, with the reason. */
export function classify(file, { map, graph }) {
  if (isDocsPath(file)) return none('documentation');
  if (reaches(graph.setup, file)) return every('the browser suite setup loads it');
  const readers = [...graph.specs].filter(([, set]) => reaches(set, file)).map(([spec]) => spec);
  if (file.startsWith(`${SPEC_DIR}/`)) return e2eFileSpecs(file, readers);
  if (UNIT_TEST.test(file)) return none('a unit test file');
  if (BUNDLED.test(file)) return mappedSpecs(file, map, readers);
  if (file.startsWith('.github/')) return none('CI configuration the browser suite does not load');
  return every(EVERY_SPEC.find(([pattern]) => pattern.test(file))[1]);
}

/**
 * The specs a change selects. A spec the map lists as incomplete runs whenever a bundled source
 * changed, because its evidence may be missing the file.
 */
export function selectSpecs({ files, map, graph, specFiles }) {
  const lines = files.map(file => ({ file, ...classify(file, { map, graph }) }));
  if (lines.some(line => line.specs === null)) return { lines, all: true, specs: specFiles };
  const chosen = new Set(lines.flatMap(line => line.specs));
  if (lines.some(line => line.mapped)) for (const spec of map.incomplete) chosen.add(spec);
  return { lines, all: false, specs: specFiles.filter(spec => chosen.has(spec)) };
}

// The command ----------------------------------------------------------------------------------

function runCommand(root) {
  return (command, args) => execFileSync(command, args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
}

/** Makes the map's commit available, fetching it when the clone lacks it. */
function hasCommit(run, commit) {
  try {
    run('git', ['cat-file', '-e', `${commit}^{commit}`]);
    return true;
  } catch {
    try {
      run('git', ['fetch', '--quiet', '--no-tags', 'origin', commit]);
      run('git', ['cat-file', '-e', `${commit}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }
}

function changedFiles(run, commit) {
  return [...new Set([
    ...run('git', ['diff', '--no-renames', '--name-only', '-z', commit, '--']).split('\0'),
    ...run('git', ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean))].sort();
}

function listSpecs(root) {
  return readdirSync(join(root, SPEC_DIR)).filter(file => file.endsWith('.e2e.ts')).map(file => `${SPEC_DIR}/${file}`).sort();
}

function minutes(root, specs) {
  const file = join(root, DURATIONS);
  if (!existsSync(file)) return '';
  const durations = JSON.parse(readFileSync(file, 'utf8')).durationsMs ?? {};
  const total = specs.reduce((sum, spec) => sum + (durations[posix.basename(spec)] ?? 0), 0);
  return `, about ${Math.max(1, Math.round(total / 60_000))} min`;
}

function report(root, loaded, selection, specFiles) {
  if (loaded.map) console.log(`${LOG} Spec map: ${loaded.file}, commit ${loaded.map.commit.slice(0, 8)}, built ${loaded.map.createdAt}.`);
  if (selection.problem) console.log(`${LOG} ${selection.problem}. Every spec runs.`);
  for (const { file, specs, reason } of selection.lines ?? []) {
    const count = specs === null ? 'every spec' : `${specs.length} spec${specs.length === 1 ? '' : 's'}`;
    console.log(`  ${file}: ${count} (${reason})`);
  }
  if (!selection.all) for (const spec of selection.specs) console.log(`  → ${spec}`);
  const time = selection.specs.length > 0 ? minutes(root, selection.specs) : '';
  console.log(`${LOG} Selected ${selection.specs.length} of ${specFiles.length} specs${time}.`);
  console.log(`${LOG} Iteration feedback only: CI still runs every spec.`);
}

function chooseSpecs(root, run, loaded, specFiles) {
  if (loaded.error) return { all: true, specs: specFiles, problem: loaded.error };
  if (!hasCommit(run, loaded.map.commit)) {
    const problem = `the map's commit ${loaded.map.commit.slice(0, 8)} is not in this clone and cannot be fetched`;
    return { all: true, specs: specFiles, problem };
  }
  const files = changedFiles(run, loaded.map.commit);
  return selectSpecs({ files, map: loaded.map, graph: referenceGraph(root, specFiles), specFiles });
}

export function main(argv) {
  const options = parseOptions(argv);
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const run = runCommand(root);
  const specFiles = listSpecs(root);
  const loaded = options.map ? readMap(resolve(options.map)) : latestMap(root, run);
  if (options.map && loaded.error) throw new Error(loaded.error);
  const chosen = chooseSpecs(root, run, loaded, specFiles);
  report(root, loaded, chosen, specFiles);
  if (options.plan) return 0;
  if (chosen.specs.length === 0) {
    console.log(`${LOG} No browser spec reaches these changes, so none runs.`);
    return 0;
  }
  const args = ['.ai/scripts/e2e.sh', ...options.forward, ...(chosen.all ? [] : chosen.specs)];
  const result = spawnSync('sh', args, { cwd: root, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`${LOG} ${error.message}`);
    process.exitCode = 2;
  }
}
