import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('documents only current message commands in README examples', () => {
  const readme = readFileSync(new URL('../../../../README.md', import.meta.url), 'utf8');
  expect(readme).not.toMatch(/\bworker (?:send|progress|follow-up|reply|conversation|inbox|cancel-request|wait-requests)\b/);
  expect(readme).not.toMatch(/\bworker wait --request\b/);
  expect(readme).toContain('cez message request');
  expect(readme).toContain('cez worker resume');
});
