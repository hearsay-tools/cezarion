import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { beginNodeCapture, endNodeCapture } from '../../e2e/spec-map/node-control.ts'

const preload = resolve(import.meta.dirname, '../../e2e/spec-map/node-preload.mjs')
const directories: string[] = []
const children: ChildProcessWithoutNullStreams[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function fixture(existing?: { directory: string; spec: string }, executable = false) {
  const directory = existing?.directory ?? mkdtempSync(join(tmpdir(), 'cez-map-test-'))
  if (!existing) directories.push(directory)
  const dist = join(directory, 'dist')
  mkdirSync(dist, { recursive: true })
  const mock = join(directory, 'mock-case.mjs')
  writeFileSync(mock, `#!${process.execPath}\nfunction scenario() { return 42 }; scenario(); console.log('ready'); process.stdin.resume();`)
  chmodSync(mock, 0o755)
  const entry = join(dist, 'index.js')
  writeFileSync(entry, `
    const { spawn } = require('node:child_process');
    let child;
    let created;
    process.stdin.on('data', task => {
      if (task.toString().trim() === 'create') {
        created = require('node:crypto').randomUUID({ disableEntropyCache: true });
        console.log('created:' + created); return;
      }
      if (task.toString().trim() === 'launch-created') task = Buffer.from(created);
      if (task.toString().trim() === 'stop') {
        child.once('exit', (code, signal) => console.log('stopped:' + signal));
        child.kill('SIGTERM'); return;
      }
      child = spawn(${executable ? JSON.stringify(mock) : 'process.execPath'}, ${executable ? '[]' : `[${JSON.stringify(mock)}]`}, {env: {...process.env, CEZ_TASK_ID: task.toString().trim()}});
      child.stdout.pipe(process.stdout);
    });
    process.on('SIGTERM', () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) process.exit(0);
      child.once('exit', () => process.exit(0)); child.kill('SIGTERM');
    });
    console.log('server');
  `)
  const child = spawn(process.execPath, ['--import', preload, entry], {
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}`, E2E_SPEC_MAP_NODE_DIR: directory, ...(existing ? { E2E_SPEC_MAP_SPEC: existing.spec } : {}) },
  })
  children.push(child)
  await once(child.stdout, 'data')
  return { directory, child }
}

function results(directory: string): Array<{ url: string; functions: Array<{ functionName: string; ranges: Array<{ count: number }> }> }> {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter(file => file.endsWith('.json'))
    .flatMap(file => (JSON.parse(readFileSync(join(directory, file), 'utf8')) as { result?: [] }).result ?? [])
}

test('records server functions and live mock coverage under the task owner spec', async () => {
  const { directory, child } = await fixture()
  const spec = 'packages/web/e2e/first.e2e.ts'
  await beginNodeCapture(directory, spec)
  const ready = once(child.stdout, 'data')
  child.stdin.write('task-first\n')
  await ready
  await endNodeCapture(directory, spec)
  const evidence = results(join(directory, 'first', 'node'))
  expect(evidence.some(script => script.url.endsWith('/dist/index.js'))).toBe(true)
  expect(evidence.find(script => script.url.endsWith('/mock-case.mjs'))?.functions)
    .toEqual(expect.arrayContaining([expect.objectContaining({ functionName: 'scenario', ranges: expect.arrayContaining([expect.objectContaining({ count: 1 })]) })]))
  await beginNodeCapture(directory, 'packages/web/e2e/second.e2e.ts')
  await endNodeCapture(directory, 'packages/web/e2e/second.e2e.ts')
  expect(results(join(directory, 'second', 'node')).some(script => script.url.endsWith('/mock-case.mjs'))).toBe(false)
})


test('flushes a terminated mock and preserves its SIGTERM exit signal', async () => {
  const { directory, child } = await fixture()
  const spec = 'packages/web/e2e/terminated.e2e.ts'
  await beginNodeCapture(directory, spec)
  const ready = once(child.stdout, 'data')
  child.stdin.write('task-terminated\n')
  await ready
  const stopped = once(child.stdout, 'data')
  child.stdin.write('stop\n')
  expect((await stopped)[0].toString()).toContain('stopped:SIGTERM')
  await endNodeCapture(directory, spec)
  const evidence = results(join(directory, 'terminated', 'node'))
  expect(evidence.find(script => script.url.endsWith('/mock-case.mjs'))?.functions)
    .toEqual(expect.arrayContaining([expect.objectContaining({ functionName: 'scenario' })]))
})


test('keeps the shared control endpoint when a spec starts and stops a fixture server', async () => {
  const { directory, child } = await fixture()
  const spec = 'packages/web/e2e/fixture.e2e.ts'
  await beginNodeCapture(directory, spec)
  const extra = await fixture({ directory, spec })
  expect(JSON.parse(readFileSync(join(directory, 'control.json'), 'utf8')).pid).toBe(child.pid)
  const nodeDirectory = join(directory, 'fixture', 'node')
  expect(JSON.parse(readFileSync(join(nodeDirectory, `expected-server-${extra.child.pid}.json`), 'utf8')))
    .toEqual({ spec, pid: extra.child.pid })
  expect(JSON.parse(readFileSync(join(nodeDirectory, `expected-server-${child.pid}.json`), 'utf8')))
    .toEqual({ spec, pid: child.pid })
  const exited = once(extra.child, 'exit')
  extra.child.kill('SIGTERM')
  await exited
  await endNodeCapture(directory, spec)
  expect(readdirSync(join(directory, 'fixture', 'node')))
    .toEqual(expect.arrayContaining([expect.stringMatching(new RegExp('^server-' + extra.child.pid + '-'))]))
})


test('records an expected result directory for each mock spawn on the same task', async () => {
  const { directory, child } = await fixture()
  const spec = 'packages/web/e2e/restarted.e2e.ts'
  await beginNodeCapture(directory, spec)
  for (let attempt = 0; attempt < 2; attempt++) {
    const ready = once(child.stdout, 'data')
    child.stdin.write('task-restarted\n')
    await ready
    const stopped = once(child.stdout, 'data')
    child.stdin.write('stop\n')
    await stopped
  }
  await endNodeCapture(directory, spec)
  const taskDirectory = join(directory, 'restarted', 'node', 'tasks', 'task-restarted')
  const spawns = readdirSync(taskDirectory)
  expect(spawns).toHaveLength(2)
  for (const spawnDirectory of spawns) {
    const output = join(taskDirectory, spawnDirectory)
    expect(JSON.parse(readFileSync(join(output, 'expected.json'), 'utf8')))
      .toEqual({ spec, taskId: 'task-restarted' })
    expect(results(output).some(script => script.url.endsWith('/mock-case.mjs'))).toBe(true)
  }
})


test('captures an executable mock supplied as the spawn command', async () => {
  const { directory, child } = await fixture(undefined, true)
  const spec = 'packages/web/e2e/executable.e2e.ts'
  await beginNodeCapture(directory, spec)
  const ready = once(child.stdout, 'data')
  child.stdin.write('task-executable\n')
  await ready
  await endNodeCapture(directory, spec)
  expect(results(join(directory, 'executable', 'node')).find(script => script.url.endsWith('/mock-case.mjs'))?.functions)
    .toEqual(expect.arrayContaining([expect.objectContaining({ functionName: 'scenario' })]))
})


test('attributes a delayed first spawn to the spec that created its task UUID', async () => {
  const { directory, child } = await fixture()
  const first = 'packages/web/e2e/created-first.e2e.ts'
  const second = 'packages/web/e2e/started-second.e2e.ts'
  await beginNodeCapture(directory, first)
  const created = once(child.stdout, 'data')
  child.stdin.write('create\n')
  const taskId = (await created)[0].toString().trim().slice('created:'.length)
  expect(taskId).toMatch(/^[0-9a-f-]{36}$/)
  await endNodeCapture(directory, first)
  await beginNodeCapture(directory, second)
  const ready = once(child.stdout, 'data')
  child.stdin.write('launch-created\n')
  await ready
  await endNodeCapture(directory, second)
  expect(results(join(directory, 'created-first', 'node')).some(script => script.url.endsWith('/mock-case.mjs'))).toBe(true)
  expect(results(join(directory, 'started-second', 'node')).some(script => script.url.endsWith('/mock-case.mjs'))).toBe(false)
  expect(readdirSync(directory).some(file => file.startsWith('ambiguous-task-'))).toBe(false)
})

test('marks a task with unknown creation ownership as ambiguous', async () => {
  const { directory, child } = await fixture()
  const spec = 'packages/web/e2e/unknown-task.e2e.ts'
  await beginNodeCapture(directory, spec)
  const ready = once(child.stdout, 'data')
  child.stdin.write('unknown-task\n')
  await ready
  await endNodeCapture(directory, spec)
  expect(JSON.parse(readFileSync(join(directory, 'ambiguous-task-unknown-task.json'), 'utf8')))
    .toEqual({ taskId: 'unknown-task' })
})
