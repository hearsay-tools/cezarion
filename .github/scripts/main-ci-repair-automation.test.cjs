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
