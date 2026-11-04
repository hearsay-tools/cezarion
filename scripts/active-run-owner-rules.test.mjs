import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownerGroups, renderOwnerRule, ruleFile } from './active-run-owner-rules.mjs';

for (const group of Object.keys(ownerGroups)) {
  test(`the ${group} ownership rule matches its reviewed template and metadata`, () => {
    assert.equal(readFileSync(ruleFile(group), 'utf8'), renderOwnerRule(group),
      'Run node scripts/active-run-owner-rules.mjs --write after changing the template or metadata');
  });
}
