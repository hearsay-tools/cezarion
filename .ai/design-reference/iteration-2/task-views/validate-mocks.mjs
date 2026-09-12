import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as contract from '../../../../packages/cezar/dist/contract/index.js';
const file = resolve('.ai/design-reference/iteration-2/task-views/populated-mocks.json');
const fixtures = JSON.parse(readFileSync(file, 'utf8'));
const schemas = {
  '/github/ref-status?*': contract.githubRefStatusDataSchema,
  '/runs': contract.runRecordSchema.array(),
  '/todos': contract.todoItemSchema.array(),
  '/groups/fixture-group': contract.groupResponseSchema,
  '/plan': contract.planResponseSchema,
  '/projects': contract.projectsResponseSchema,
  '/workspace/runs-index': contract.runsIndexResponseSchema,
  '/automations': contract.automationsResponseSchema,
  '/automation-log?*': contract.automationLogResponseSchema,
};
const results = fixtures.map(({path, body}) => {
  const schema = schemas[path];
  if (!schema) throw new Error(`No contract validator for ${path}`);
  const parsed = schema.safeParse(body);
  return { path, valid: parsed.success, ...(parsed.success ? {} : {issues: parsed.error.issues}) };
});
writeFileSync(file.replace('populated-mocks.json', 'fixture-validation.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
if (results.some(result => !result.valid)) process.exitCode = 1;
