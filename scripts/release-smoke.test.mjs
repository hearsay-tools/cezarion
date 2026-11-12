import assert from 'node:assert/strict';
import test from 'node:test';
import { bootEnv, cockpitAsset, parseArgs } from './release-smoke.mjs';

test('the smoke takes a package, an exact version and an optional upgrade source', () => {
  assert.deepEqual(parseArgs(['--package', '@hearsay-tools/squawk', '--version', '1.2.1-rc.1']),
    { name: '@hearsay-tools/squawk', version: '1.2.1-rc.1', upgradeFrom: undefined });
  assert.deepEqual(parseArgs(['--package', 'cezarion', '--version', '1.2.1', '--upgrade-from', '1.2.0']),
    { name: 'cezarion', version: '1.2.1', upgradeFrom: '1.2.0' });
  assert.throws(() => parseArgs(['--package', 'cezarion']), /--version is required/);
  assert.throws(() => parseArgs(['--package', 'cezarion', '--version', 'latest']), /Invalid version/);
  assert.throws(() => parseArgs(['--package', 'x; rm -rf /', '--version', '1.0.0']), /Invalid package name/);
  assert.throws(() => parseArgs(['--tag', 'next']), /Usage/);
});

test('the cockpit check needs the module script a built cockpit page loads', () => {
  assert.equal(cockpitAsset('<script type="module" crossorigin src="/assets/index-AbC123.js"></script>'), '/assets/index-AbC123.js');
  assert.equal(cockpitAsset('<html><body>Build the cockpit first</body></html>'), null);
});

test('no ambient product setting reaches the booted package', () => {
  const env = bootEnv({ PATH: '/bin', CEZ_PREVIEW: '1', hsq_task_id: 'x', HSQ_HOME: '/real' }, '/tmp/h');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.CEZ_PREVIEW, undefined);
  assert.equal(env.hsq_task_id, undefined);
  assert.equal(env.HSQ_HOME, '/tmp/h/product');
  assert.equal(env.CEZ_HOME, '/tmp/h/product');
  assert.equal(env.HOME, '/tmp/h/user');
  assert.equal(env.HSQ_DRY_RUN, '1');
});
