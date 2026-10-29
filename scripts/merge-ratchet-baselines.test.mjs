import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createTestSandbox } from './test-sandbox.mjs'


const root = resolve(import.meta.dirname, '..')
// Keep the Git regression executable against the pre-driver snapshot for red/green proof.
const setupMergeDriver = existsSync(join(root, 'scripts/setup-merge-drivers.mjs'))
  ? (await import('./setup-merge-drivers.mjs')).setupMergeDriver : undefined
const lengthPath = 'packages/cezar/src/file-length.baseline.json'
const astPath = '.ai/ast-grep/rules/example.baseline.json'
const length = files => ({ $comment: 'pins', limit: 1000, files })
const site = (name, count = 2) => ({ file: 'a.ts', rule: 'example', site: name, count })
const ast = sites => ({ $comment: 'sites', sites })
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

function fixture(t, install = true) {
  const cwd = createTestSandbox('cez-ratchet-merge-')
  mkdirSync(join(cwd, 'scripts'))
  git(cwd, 'init', '-b', 'main')
  git(cwd, 'config', 'user.name', 'Test')
  git(cwd, 'config', 'user.email', 'test@example.invalid')
  if (existsSync(join(root, '.gitattributes'))) copyFileSync(join(root, '.gitattributes'), join(cwd, '.gitattributes'))
  if (install && existsSync(join(root, 'scripts/setup-merge-drivers.mjs'))) {
    for (const name of ['merge-ratchet-baselines.mjs', 'setup-merge-drivers.mjs']) {
      copyFileSync(join(root, 'scripts', name), join(cwd, 'scripts', name))
    }
    setupMergeDriver(cwd)
  }
  return cwd
}

function put(cwd, path, value) {
  mkdirSync(resolve(cwd, path, '..'), { recursive: true })
  writeFileSync(join(cwd, path), JSON.stringify(value, null, 2) + '\n')
}

function merge(t, path, base, ours, theirs, install = true) {
  const cwd = fixture(t, install)
  put(cwd, path, base)
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'base')
  git(cwd, 'switch', '-c', 'other')
  put(cwd, path, theirs)
  git(cwd, 'commit', '-am', 'theirs')
  git(cwd, 'switch', 'main')
  put(cwd, path, ours)
  git(cwd, 'commit', '-am', 'ours')
  const result = spawnSync('git', ['merge', '--no-edit', 'other'], { cwd, encoding: 'utf8' })
  return { cwd, result, text: readFileSync(join(cwd, path), 'utf8') }
}

test('actual Git merge resolves adjacent independent pin reductions', t => {
  const { result, text } = merge(t, lengthPath, length({ a: 1500, b: 1600 }), length({ a: 1400, b: 1600 }), length({ a: 1500, b: 1550 }))
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(JSON.parse(text).files, { a: 1400, b: 1550 })
})

test('ordinary Git reproduces the adjacent-pin conflict without registration', t => {
  const { result, text } = merge(t, lengthPath, length({ a: 1500, b: 1600 }), length({ a: 1400, b: 1600 }), length({ a: 1500, b: 1550 }), false)
  assert.equal(result.status, 1)
  assert.match(text, /<<<<<<< /)
})

test('actual Git merge matches AST identities and takes minimum counts', t => {
  const { result, text } = merge(t, astPath, ast([site('one'), site('two')]), ast([site('one', 1), site('two')]), ast([site('one'), site('two', 1)]))
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(JSON.parse(text).sites, [site('one', 1), site('two', 1)])
})

function drive(t, base, ours, theirs) {
  const cwd = createTestSandbox('cez-ratchet-input-')
  for (const [name, value] of Object.entries({ base, ours, theirs })) {
    writeFileSync(join(cwd, name), typeof value === 'string' ? value : JSON.stringify(value))
  }
  const before = readFileSync(join(cwd, 'ours'), 'utf8')
  const result = spawnSync(process.execPath, [join(root, 'scripts/merge-ratchet-baselines.mjs'), ...['base', 'ours', 'theirs'].map(name => join(cwd, name))], { encoding: 'utf8' })
  return { result, before, text: readFileSync(join(cwd, 'ours'), 'utf8') }
}

for (const [name, base, ours, theirs, expected] of [
  ['minimum pin', length({ a: 1500 }), length({ a: 1400 }), length({ a: 1300 }), length({ a: 1300 })],
  ['new key', length({ a: 1500 }), length({ a: 1400 }), length({ a: 1500, b: 1700 }), length({ a: 1400, b: 1700 })],
  ['removed pin', length({ a: 1500, b: 1600 }), length({ b: 1600 }), length({ a: 1500, b: 1500 }), length({ b: 1500 })],
  ['removed site', ast([site('one'), site('two')]), ast([site('two')]), ast([site('one'), site('two', 1)]), ast([site('two', 1)])],
  ['new site', ast([site('one')]), ast([site('one', 1)]), ast([site('one'), site('two')]), ast([site('one', 1), site('two')])],
  ['metadata', length({ a: 1500 }), { ...length({ a: 1400 }), $comment: 'updated' }, length({ a: 1300 }), { ...length({ a: 1300 }), $comment: 'updated' }],
]) {
  test(`driver preserves ${name}`, t => {
    const { result, text } = drive(t, base, ours, theirs)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(text), expected)
    const reversed = drive(t, base, theirs, ours)
    assert.equal(reversed.result.status, 0, reversed.result.stderr)
    assert.deepEqual(JSON.parse(reversed.text), expected)
  })
}

for (const [name, base, ours, theirs] of [
  ['deletion versus edit', length({ a: 1500 }), length({}), length({ a: 1400 })],
  ['metadata conflict', length({}), { ...length({}), $comment: 'ours' }, { ...length({}), $comment: 'theirs' }],
  ['invalid JSON', length({}), '{', length({})],
  ['unknown shape', length({}), { unknown: 1 }, length({})],
  ['negative pin', length({}), length({ a: -1 }), length({})],
  ['duplicate AST identity', ast([]), ast([site('one'), site('one')]), ast([])],
  ['site deletion versus edit', ast([site('one')]), ast([]), ast([site('one', 1)])],
]) {
  test(`driver refuses ${name} without replacing ours`, t => {
    const { result, before, text } = drive(t, base, ours, theirs)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Ratchet merge:/)
    assert.equal(text, before)
  })
}

test('installer is idempotent, shared with linked worktrees, and refuses overrides', t => {
  const cwd = fixture(t)
  const args = ['scripts/setup-merge-drivers.mjs']
  setupMergeDriver(cwd)
  assert.equal(git(cwd, 'config', '--local', '--get-all', 'merge.cezar-ratchet.driver'), 'node scripts/merge-ratchet-baselines.mjs "%O" "%A" "%B"')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'setup')
  const linked = join(createTestSandbox('cez-ratchet-linked-'), 'tree with spaces')
  git(cwd, 'worktree', 'add', '-b', 'linked', linked)
  assert.equal(git(linked, 'config', '--get', 'merge.cezar-ratchet.driver'), git(cwd, 'config', '--get', 'merge.cezar-ratchet.driver'))
  execFileSync(process.execPath, args, { cwd: linked })
  git(cwd, 'config', '--local', 'merge.cezar-ratchet.driver', 'custom-driver')
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.throws(() => setupMergeDriver(cwd), /different definition/)
  assert.equal(git(cwd, 'config', '--get', 'merge.cezar-ratchet.driver'), 'custom-driver')
})


test('actual Git merge retains a new key alongside an independent reduction', t => {
  const { result, text } = merge(t, lengthPath, length({ a: 1500 }), length({ a: 1400 }), length({ a: 1500, b: 1700 }))
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(JSON.parse(text).files, { a: 1400, b: 1700 })
})

test('actual Git leaves deletion versus modification unmerged', t => {
  const { cwd, result } = merge(t, lengthPath, length({ a: 1500 }), length({}), length({ a: 1400 }))
  assert.equal(result.status, 1)
  assert.match(git(cwd, 'ls-files', '--unmerged'), /file-length\.baseline\.json/)
})

test('attributes leave unrelated baseline files on the ordinary merge path', t => {
  const cwd = fixture(t)
  assert.equal(git(cwd, 'check-attr', 'merge', '--', 'other.baseline.json'), 'other.baseline.json: merge: unspecified')
})
