const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { parse } = require('yaml');

const source = readFileSync(join(__dirname, '../workflows/refresh-test-durations.yml'), 'utf8');
const workflow = parse(source);
const { measure, propose } = workflow.jobs;

test('daily refresh runs unattended with a read-only measurement and a guarded PR writer', () => {
  assert.deepEqual(workflow.on.schedule, [{ cron: '25 4 * * *' }]);
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(measure.permissions, { contents: 'read', actions: 'read' });
  assert.deepEqual(propose.permissions, { contents: 'write', 'pull-requests': 'read' });
  assert.match(propose.if, /github.ref == 'refs\/heads\/main'/);
  assert.match(propose.if, /github.event_name == 'schedule'/);
  assert.match(propose.if, /github.event_name == 'workflow_dispatch' && inputs.dry_run == false/);
  assert.match(propose.if, /needs.measure.outputs.changed == 'true'/);
  assert.equal(propose.needs, 'measure');
  assert.equal(workflow.on.pull_request_target, undefined);
  assert.equal(workflow.on.merge_group, undefined);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
});

test('refresh artifacts carry only the manifests, and app-authored PRs receive normal CI', () => {
  const upload = measure.steps.find(step => step.name === 'Upload refreshed manifests');
  const download = propose.steps.find(step => step.name === 'Download refreshed manifests');
  assert.equal(upload.with.name, download.with.name);
  assert.equal(upload.with['include-hidden-files'], true);
  assert.equal(download.with.path, '.github');
  assert.deepEqual(upload.with.path.trim().split('\n'), ['.github/cockpit-test-durations.json', '.github/test-durations.json']);
  assert.equal(measure.steps.find(step => step.id === 'refresh').run, 'node .github/scripts/refresh-test-durations.mjs');
  const open = propose.steps.find(step => step.name === 'Open the refresh PR');
  assert.equal(open.env.GH_TOKEN, '${{ steps.app.outputs.token }}');
  assert.match(open.run, /gh pr create .*--base main --head/);
  assert.doesNotMatch(open.run, /--draft|gh pr merge/);
  for (const step of propose.steps.slice(2)) assert.equal(step.if, "steps.existing.outputs.count == '0'");
  assert.match(propose.steps.find(step => step.id === 'existing').run, /--state open --limit 1000/);
  const app = propose.steps.find(step => step.id === 'app');
  assert.equal(app.with['permission-pull-requests'], 'write');
  assert.equal(app.with['permission-contents'], undefined);
  for (const step of [...measure.steps, ...propose.steps].filter(step => step.uses)) {
    assert.match(step.uses, /^(?:[\w-]+\/[\w-]+@[0-9a-f]{40}|\.\/\.github\/actions\/node-dist)$/);
  }
});
