const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');

test('repair migration emits only a prompt patch, leaving enablement and launch settings to the existing automation',()=>{
  const result=spawnSync(process.execPath,[path.join(__dirname,'main-ci-repair-automation.cjs')],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const patch=JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(patch),['task']);
  assert.deepEqual(Object.keys(patch.task),['prompt']);
  assert.equal(typeof patch.task.prompt,'string');
  assert.ok(patch.task.prompt.length>100);
  assert.equal(result.stderr,'');
});

test('repair instructions reconcile every report without closing unresolved causes',()=>{
  const {prompt}=require('./main-ci-repair-automation.cjs');
  assert.match(prompt,/Already fixed on current main:[^\n]+close the report now/);
  assert.match(prompt,/Fixed by the new repair PR:[^\n]+closing reference for every report fully resolved[^\n]+Keep these reports open until merge/);
  assert.match(prompt,/Include aggregate reports only when every cause they reflect is already resolved or fixed by the PR/);
  assert.match(prompt,/Duplicate of an unresolved cause: first link its occurrence evidence from the canonical open issue[^\n]+close only the duplicate/);
  assert.match(prompt,/Unresolved cause, missing evidence, do-not-close protection or competing claim: keep the report open/);
  assert.match(prompt,/Never close members just because their summary closed/);
  assert.match(prompt,/Before finishing, re-fetch issue states and the PR's closing references/);
});
