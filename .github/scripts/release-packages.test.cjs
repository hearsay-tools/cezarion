const test = require('node:test');
const assert = require('node:assert/strict');
const { installAlias, publishedNames } = require('./release-packages.cjs');

// The Release plan reads both: the alias the candidate tests install, and every name the
// tag checks cover. Both follow the product identity, with and without the rebrand.
test('the install alias is the alias, or the compatibility alias after the rebrand', () => {
  assert.equal(installAlias(undefined, false), 'cezarion');
  assert.equal(installAlias(undefined, true), 'cezarion');
});

test('the published names are every publishable name, in publication order', () => {
  assert.deepEqual(publishedNames(undefined, true), ['@hearsay-tools/squawk', '@wjarka/cezarion', 'cezarion']);
  assert.deepEqual(publishedNames(undefined, false), ['@wjarka/cezarion', 'cezarion']);
});
