import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

function vitestConfigs(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && !['node_modules', 'dist', '.git', '.ai'].includes(entry.name)) return vitestConfigs(path)
    return entry.isFile() && /^vitest\.config\./.test(entry.name) ? [path] : []
  })
}

test('every root and package Vitest config invokes the shared install guard', () => {
  const root = resolve(import.meta.dirname, '..')
  const rootConfigs = readdirSync(root).filter(name => /^vitest\.config\./.test(name)).map(name => join(root, name))
  const configs = [...rootConfigs, ...vitestConfigs(join(root, 'packages'))]
  assert.ok(configs.length > 0)
  for (const config of configs) {
    const source = readFileSync(config, 'utf8')
    assert.match(source, /import\s*\{\s*checkWorkspaceResolution\s*\}\s*from\s*['"][^'"]*check-workspace-resolution\.mjs['"]/, config)
    assert.match(source, /^checkWorkspaceResolution\(\)/m, config)
  }
})
