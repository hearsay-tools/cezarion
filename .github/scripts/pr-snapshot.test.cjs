const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveSnapshot, validateArchives, publishArchives } = require('./pr-snapshot.cjs');
const SHA = 'a'.repeat(40);
function fixture() {
  const run = { id: 42, run_attempt: 1, run_number: 15, path: '.github/workflows/ci.yml', event: 'pull_request_target', status: 'completed', conclusion: 'success', head_sha: SHA, head_branch: 'fix/example', head_repository: { full_name: 'o/n' } };
  const pull = { number: 7, state: 'open', head: { sha: SHA, ref: run.head_branch, repo: { full_name: 'o/n' } }, base: { ref: 'main', repo: { full_name: 'o/n' } } };
  const state = { run, pull, runs: [run], jobs: [{ name: 'Unit, build, E2E, and package', conclusion: 'success', status: 'completed' }, { name: 'Prepare PR snapshot archives', conclusion: 'success', status: 'completed' }], artifacts: [{ id: 90, name: 'pr-snapshot-1', expired: false }] };
  const github = {
    request: async (route) => ({ data: route.includes('/actions/runs/') ? state.run : state.pull }),
    paginate: async (route) => route.endsWith('/jobs') ? state.jobs : route.endsWith('/artifacts') ? state.artifacts : route.endsWith('/runs') ? state.runs : [state.pull],
  };
  return { state, options: { github, owner: 'o', repo: 'n', trigger: structuredClone(run) } };
}
test('successful current same-repo target verification permits only its attempt artifact', async () => {
  for (const base of ['main', 'develop']) {
    const f = fixture(); f.state.pull.base.ref = base;
    assert.deepEqual(await resolveSnapshot(f.options), { pr: 7, head: SHA, runId: 42, runNumber: 15, attempt: 1, artifactId: 90 });
  }
});
for (const [name, mutate] of Object.entries({
  fork: s => { s.pull.head.repo.full_name = 'fork/n'; },
  stale: s => { s.pull.head.sha = 'b'.repeat(40); },
  closed: s => { s.pull.state = 'closed'; },
  legacy: s => { s.run.event = 'pull_request'; },
  push: s => { s.run.event = 'push'; },
  failed: s => { s.jobs[0].conclusion = 'failure'; },
  cancelled: s => { s.run.conclusion = 'cancelled'; },
  missingArtifact: s => { s.artifacts = []; },
  duplicateArtifact: s => { s.artifacts.push({ ...s.artifacts[0], id: 91 }); },
  expired: s => { s.artifacts[0].expired = true; },
  oldAttempt: s => { s.run.run_attempt = 2; },
  superseded: s => { s.runs.push({ ...s.run, id: 43, status: 'in_progress', conclusion: null }); },
  unprepared: s => { s.jobs[1].conclusion = 'skipped'; },
})) test(`snapshot refuses ${name}`, async () => {
  const f = fixture(); mutate(f.state);
  assert.equal(await resolveSnapshot(f.options), null);
});
function archiveFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-snapshot-'));
  const artifacts = path.join(dir, 'artifacts'); fs.mkdirSync(artifacts);
  const manifests = { cezar: { name: '@scope/service' }, alias: { name: 'alias' } };
  const plan = { pr: 7, runNumber: 15, attempt: 1 };
  function pack(key, patch = {}) {
    const root = path.join(dir, key); fs.mkdirSync(path.join(root, 'package'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package/package.json'), JSON.stringify({ name: manifests[key].name, version: '1.2.3-pr7.15', ...(key === 'alias' ? { dependencies: { '@scope/service': '1.2.3-pr7.15' } } : {}), ...patch }));
    execFileSync('tar', ['-czf', path.join(artifacts, `${key}.tgz`), '-C', root, 'package']);
  }
  try { pack('cezar'); pack('alias'); fn({ artifacts, manifests, plan, pack, dir }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
test('publishes validated archives only, with lifecycle scripts disabled and fixed registry/tag', () => archiveFixture(f => {
  f.pack('cezar', { scripts: { prepublishOnly: 'exit 91' } });
  const entries = validateArchives(f);
  const calls = [];
  publishArchives({ entries, plan: f.plan, dryRun: true, execute: (cmd, args, options) => { calls.push({ cmd, args, options }); } });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.cmd, 'npm');
    assert.ok(call.args.includes('--ignore-scripts'));
    assert.ok(call.args.includes('--registry=https://registry.npmjs.org'));
    assert.ok(call.args.includes('--tag=pr-7'));
    assert.ok(call.args.includes('--dry-run'));
    assert.notEqual(call.options.cwd, f.artifacts);
  }
}));
for (const [name, patch] of Object.entries({ wrongName: { name: 'unrelated' }, stable: { version: '1.2.3' }, wrongPr: { version: '1.2.3-pr8.15' }, wrongRun: { version: '1.2.3-pr7.14' }, registry: { publishConfig: { registry: 'https://evil.invalid' } }, tag: { publishConfig: { tag: 'latest' } }, missingPin: { dependencies: {} } })) {
  test(`archives reject ${name}`, () => archiveFixture(f => {
    f.pack('alias', patch);
    assert.throws(() => validateArchives(f));
  }));
}
test('archives reject extra or missing packages', () => archiveFixture(f => {
  fs.writeFileSync(path.join(f.artifacts, 'extra.tgz'), 'x');
  assert.throws(() => validateArchives(f));
  fs.unlinkSync(path.join(f.artifacts, 'extra.tgz'));
  fs.unlinkSync(path.join(f.artifacts, 'alias.tgz'));
  assert.throws(() => validateArchives(f));
}));

test('publisher credentials are isolated from all PR execution', () => {
  const yaml = require('yaml');
  const workflow = yaml.parse(fs.readFileSync(path.join(__dirname, '../workflows/publish-pr-snapshot.yml'), 'utf8'));
  assert.deepEqual(workflow.on, { workflow_run: { workflows: ['CI'], types: ['completed'] } });
  assert.deepEqual(workflow.permissions, {});
  const publisher = workflow.jobs.publish;
  assert.equal(publisher.concurrency['cancel-in-progress'], false);
  for (const job of Object.values(workflow.jobs)) {
    const checkout = job.steps.find(s => s.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, '${{ github.sha }}');
    assert.equal(checkout.with['persist-credentials'], false);
    assert.ok(!job.steps.some(s => s.run), 'only trusted API scripts and pinned actions execute');
  }
  const download = publisher.steps.find(s => s.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with['artifact-ids'], '${{ fromJSON(needs.resolve.outputs.plan).artifactId }}');
  assert.equal(download.with['run-id'], '${{ fromJSON(needs.resolve.outputs.plan).runId }}');
  assert.equal(workflow.jobs.resolve.permissions['id-token'], undefined);
});

test('real npm dry-run accepts the archives and never runs hostile lifecycle scripts', () => archiveFixture(f => {
  f.pack('cezar', { scripts: { prepublishOnly: 'exit 91', publish: 'exit 92', postpublish: 'exit 93' } });
  const entries = validateArchives(f);
  let count = 0;
  publishArchives({ entries, plan: f.plan, dryRun: true, execute: (cmd, args, options) => {
    const result = execFileSync(cmd, args, { ...options, stdio: 'pipe', encoding: 'utf8', timeout: 30_000 });
    assert.match(result, /\+ (@scope\/service|alias)@1\.2\.3-pr7\.15/);
    count++;
  } });
  assert.equal(count, 2);
}));

for (const alternate of ['package/./package.json', 'package//package.json', 'package/sub/../package.json', 'package\\package.json']) {
  test(`rejects manifest path alias ${alternate}`, () => archiveFixture(f => {
    execFileSync('python3', ['-c', `
import io, json, sys, tarfile
with tarfile.open(sys.argv[1], 'w:gz') as archive:
  for name, manifest in [('package/package.json', {'name':'@scope/service','version':'1.2.3-pr7.15'}), (sys.argv[2], {'name':'different-publish-target','version':'9.9.9','publishConfig':{'registry':'https://evil.invalid'}})]:
    data=json.dumps(manifest).encode()
    info=tarfile.TarInfo(name); info.size=len(data)
    archive.addfile(info, io.BytesIO(data))
`, path.join(f.artifacts, 'cezar.tgz'), alternate]);
    assert.throws(() => validateArchives(f), /archive/);
  }));
}
test('rejects archive links instead of letting tar readers resolve them differently', () => archiveFixture(f => {
  execFileSync('python3', ['-c', `
import io, json, sys, tarfile
with tarfile.open(sys.argv[1], 'w:gz') as archive:
  data=json.dumps({'name':'@scope/service','version':'1.2.3-pr7.15'}).encode()
  info=tarfile.TarInfo('package/package.json'); info.size=len(data)
  archive.addfile(info, io.BytesIO(data))
  info=tarfile.TarInfo('package/link'); info.type=tarfile.SYMTYPE; info.linkname='/tmp/elsewhere'
  archive.addfile(info)
`, path.join(f.artifacts, 'cezar.tgz')]);
  assert.throws(() => validateArchives(f), /archive/);
}));

for (const zeroBlocks of [1, 2]) {
  test(`rejects hidden duplicate manifest after ${zeroBlocks} zero blocks`, () => archiveFixture(f => {
    execFileSync('python3', ['-c', `
import gzip, json, sys, tarfile
parts=[]
for manifest in [{'name':'@scope/service','version':'1.2.3-pr7.15'}, {'name':'different-publish-target','version':'9.9.9'}]:
  data=json.dumps(manifest).encode(); info=tarfile.TarInfo('package/package.json'); info.size=len(data)
  parts.append(info.tobuf() + data + b'\\0' * (-len(data) % 512))
with gzip.open(sys.argv[1], 'wb') as file:
  file.write(parts[0] + b'\\0' * (512 * int(sys.argv[2])) + parts[1] + b'\\0' * 1024)
`, path.join(f.artifacts, 'cezar.tgz'), String(zeroBlocks)]);
    assert.throws(() => validateArchives(f), /archive/);
  }));
}
test('publisher supplies npm only a freshly repacked archive, never the untrusted original', () => archiveFixture(f => {
  const entries = validateArchives(f);
  publishArchives({ entries, plan: f.plan, dryRun: true, execute: (cmd, args) => {
    const file = args[1];
    assert.ok(!entries.some(e => e.file === file));
    const pkg = JSON.parse(execFileSync('tar', ['-xOzf', file, 'package/package.json'], { encoding: 'utf8' }));
    assert.equal(pkg.version, '1.2.3-pr7.15');
  } });
}));
