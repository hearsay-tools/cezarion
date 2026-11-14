const test = require('node:test');
const assert = require('node:assert/strict');
const { installAlias, publishedNames } = require('./release-packages.cjs');

// The Release plan reads both: the alias the candidate tests install, and every name the
// tag checks cover.
test('the install alias is the old unscoped alias, now a compatibility package', () => {
  assert.equal(installAlias(), 'cezarion');
});

test('the published names are every publishable name, in publication order', () => {
  assert.deepEqual(publishedNames(), ['@hearsay-tools/squawk', '@wjarka/cezarion', 'cezarion']);
});
