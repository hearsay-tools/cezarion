import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkWorkspaceResolution } from './check-workspace-resolution.mjs'

function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'workspace-resolution-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const root = join(temp, 'tree')
  for (const path of ['node_modules', 'packages/a/node_modules', 'packages/b/node_modules']) mkdirSync(join(root, path), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/a', 'packages/b'] }))
  writeFileSync(join(root, 'packages/a/package.json'), JSON.stringify({ name: 'a', dependencies: { b: '*' } }))
  const manifest = JSON.stringify({ name: 'b', exports: './unbuilt.js' })
  writeFileSync(join(root, 'packages/b/package.json'), manifest)
  return { temp, root, manifest, link: join(root, 'packages/a/node_modules/b') }
}

test('accepts workspace links inside this checkout, with unbuilt and restricted exports', t => {
  const { root, link } = fixture(t)
  symlinkSync(join(root, 'packages/b'), link, 'dir')
  assert.doesNotThrow(() => checkWorkspaceResolution(root))
})

test('rejects a workspace dependency that resolves outside this checkout', t => {
  const { temp, root, manifest, link } = fixture(t)
  const outside = join(temp, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'package.json'), manifest)
  symlinkSync(outside, link, 'dir')
  assert.throws(() => checkWorkspaceResolution(root), /run `pnpm install --frozen-lockfile`/)
})

test('rejects a missing root install before testing packages', t => {
  const { root } = fixture(t)
  rmSync(join(root, 'node_modules'), { recursive: true })
  assert.throws(() => checkWorkspaceResolution(root), /run `pnpm install --frozen-lockfile`/)
})
