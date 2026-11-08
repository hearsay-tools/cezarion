import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

test('nightly producers pin both release channel aliases to the same value', () => {
  for (const name of ['nightly', 'ci-benchmark']) {
    const workflow = parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
    const steps = Object.values(workflow.jobs).flatMap(job => job.steps ?? []);
    const producers = steps.filter(step => step.env?.CEZ_RELEASE_CHANNEL !== undefined);
    assert.equal(producers.length, 1);
    assert.equal(producers[0].env.CEZ_RELEASE_CHANNEL, 'nightly');
    assert.equal(producers[0].env.HSQ_RELEASE_CHANNEL, producers[0].env.CEZ_RELEASE_CHANNEL);
  }
});

test('both E2E builders pin the preferred flag over a conflicting inherited value', async () => {
  const { execFileSync } = await import('node:child_process');
  for (const path of ['../.ai/scripts/build-e2e.sh', '../.github/workflows/e2e-spec-map.yml']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    const prefix = source.match(/NODE_ENV=production [^\n]*?(?=npm run build)/)?.[0];
    assert.ok(prefix, path);
    const result = execFileSync('sh', ['-c', `${prefix} "$ENV_TEST_NODE" -e 'process.stdout.write(process.env.VITE_HSQ_E2E + ":" + process.env.VITE_CEZ_E2E)'`], {
      env: {...process.env, ENV_TEST_NODE: process.execPath, VITE_HSQ_E2E: '0', VITE_CEZ_E2E: '0'}, encoding: 'utf8',
    });
    assert.equal(result, '1:1', path);
  }
});

test('the public README table includes each supported preferred name', () => {
  const contract = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').split('Useful environment variables:')[1].split('### Troubleshooting:')[0];
  for (const name of new Set(contract.match(/(?:VITE_)?HSQ_[A-Z0-9_]+/g))) assert.ok(readme.includes('`' + name), name);
});
