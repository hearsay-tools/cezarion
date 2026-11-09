import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { nodeCaptureComplete } from '../../e2e/spec-map/node-evidence.ts'
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
  for (const directory of directories.splice(0)) {
    // Our precise-coverage reads reset V8's shared counters. Preserve those reads for
    // an external collector before removing the test's own evidence.
    const external = process.env.NODE_V8_COVERAGE
    if (external) {
      mkdirSync(external, { recursive: true })
      for (const file of readdirSync(directory, { recursive: true, encoding: 'utf8' })) {
        if (/^(?:server-|shared-startup-).*\.json$/.test(basename(file))) {
          copyFileSync(join(directory, file), join(external, `${basename(directory)}-${basename(file)}`))
        }
      }
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

async function fixture(existing?: { directory: string; spec: string }, executable = false) {
  const directory = existing?.directory ?? mkdtempSync(join(tmpdir(), 'cez-map-test-'))
  if (!existing) directories.push(directory)
  // The caller's TMPDIR may sit below a package with type=module.
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'commonjs' }))
  const dist = join(directory, 'dist')
  mkdirSync(dist, { recursive: true })
  const mock = join(directory, 'mock-case.mjs')
  writeFileSync(mock, `#!${process.execPath}\nfunction scenario() { return 42 }; scenario(); console.log('ready'); process.stdin.resume();`)
  chmodSync(mock, 0o755)
  const entry = join(dist, 'index.js')
  writeFileSync(entry, `
    const { spawn } = require('node:child_process');
    function boot() { return 42; }
    boot();
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
    .flatMap(file => {
      const report = JSON.parse(readFileSync(join(directory, file), 'utf8')) as { result?: [] }
      return report.result ?? []
    })
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
  const created = once(child.stdout, 'data')
  child.stdin.write('create\n')
  const taskId = (await created)[0].toString().trim().slice('created:'.length)
  const ready = once(child.stdout, 'data')
  child.stdin.write(`${taskId}\n`)
  await ready
  expect(readdirSync(directory).filter(file => file.startsWith('ambiguous-task-'))).toEqual([])
  const stopped = once(child.stdout, 'data')
  child.stdin.write('stop\n')
  expect((await stopped)[0].toString()).toContain('stopped:SIGTERM')
  await endNodeCapture(directory, spec)
  expect(nodeCaptureComplete(directory, spec)).toBe(true)
  const evidence = results(join(directory, 'terminated', 'node'))
  expect(evidence.find(script => script.url.endsWith('/mock-case.mjs'))?.functions)
    .toEqual(expect.arrayContaining([expect.objectContaining({ functionName: 'scenario' })]))
})


test('rejects a terminated mock with no coverage for its pid', async () => {
  const { directory } = await fixture()
  const spec = 'packages/web/e2e/missing-coverage.e2e.ts'
  await beginNodeCapture(directory, spec)
  const coverageDirectory = join(directory, 'missing-coverage', 'node', 'tasks', 'terminated')
  mkdirSync(coverageDirectory, { recursive: true })
  const pid = 123456789
  // A different process's coverage must not acknowledge this terminated mock.
  writeFileSync(join(coverageDirectory, `coverage-${pid + 1}-0-0.json`), '{}')
  writeFileSync(join(directory, 'processes', `${pid}.json`), JSON.stringify({
    pid, spec, coverageDirectory, socket: join(directory, 'absent.sock'),
  }))
  const otherSpec = 'packages/web/e2e/other.e2e.ts'
  await beginNodeCapture(directory, otherSpec)
  await expect(endNodeCapture(directory, otherSpec)).resolves.toBeUndefined()
  await expect(endNodeCapture(directory, spec)).rejects.toThrow(
    `Node coverage missing for terminated process ${pid} (${spec}) in ${coverageDirectory}`,
  )
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
  expect(readdirSync(directory).filter(file => file.startsWith('shared-startup-')))
    .toEqual([`shared-startup-${child.pid}.json`])
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


test('retains shared startup function execution across later spec resets', async () => {
  const { directory, child } = await fixture()
  const startupFile = join(directory, `shared-startup-${child.pid}.json`)
  await beginNodeCapture(directory, 'packages/web/e2e/boot-first.e2e.ts')
  const initial = readFileSync(startupFile, 'utf8')
  const startup = JSON.parse(initial) as { result: ReturnType<typeof results>; peakRssKiB: number }
  expect(startup.peakRssKiB).toBeGreaterThan(0)
  expect(startup.result.find(script => script.url.endsWith('/dist/index.js'))?.functions)
    .toEqual(expect.arrayContaining([expect.objectContaining({ functionName: 'boot', ranges: expect.arrayContaining([expect.objectContaining({ count: 1 })]) })]))
  await endNodeCapture(directory, 'packages/web/e2e/boot-first.e2e.ts')
  await beginNodeCapture(directory, 'packages/web/e2e/boot-second.e2e.ts')
  await endNodeCapture(directory, 'packages/web/e2e/boot-second.e2e.ts')
  expect(readFileSync(startupFile, 'utf8')).toBe(initial)
  const later = results(join(directory, 'boot-second', 'node'))
    .flatMap(script => script.functions.filter(fn => fn.functionName === 'boot'))
  expect(later.every(fn => fn.ranges.every(range => range.count === 0))).toBe(true)
})


test('attributes a seeded task to its private server spec without invalidating shared evidence', async () => {
  const { directory } = await fixture()
  const spec = 'packages/web/e2e/seeded.e2e.ts'
  await beginNodeCapture(directory, spec)
  const { child } = await fixture({ directory, spec })
  const ready = once(child.stdout, 'data')
  child.stdin.write('seeded-task\n')
  await ready
  await endNodeCapture(directory, spec)
  expect(nodeCaptureComplete(directory, spec)).toBe(true)
  expect(readdirSync(directory).filter(name => name.startsWith('ambiguous-task-'))).toEqual([])
})


test('keeps the mock capture endpoint out of TypeScript loader threads', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cez-map-loader-'))
  directories.push(directory)
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href
  const module = pathToFileURL(resolve(import.meta.dirname, '../../e2e/spec-map/node-control.ts')).href
  const code = `const { register } = await import(${JSON.stringify(loader)}); register(); await import(${JSON.stringify(module)}); console.log('loaded');`
  const child = spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-e', code], {
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}`, E2E_SPEC_MAP_NODE_DIR: directory,
      E2E_SPEC_MAP_OWNER: 'packages/web/e2e/loader.e2e.ts', TSX_DISABLE_CACHE: '1', NODE_V8_COVERAGE: join(directory, 'coverage') },
    // bound: a loader deadlock cannot acknowledge or process SIGTERM; kill only this fixture.
    timeout: 5_000, killSignal: 'SIGKILL', encoding: 'utf8',
  })
  expect(child.error).toBeUndefined()
  expect(child.status).toBe(0)
  expect(child.stdout).toContain('loaded')
})

test.each([true, false])('uses the final coverage receipt only for matching process identity (%s)', async (validReceipt) => {
  const { directory } = await fixture()
  const spec = 'packages/web/e2e/exit-race.e2e.ts'
  await beginNodeCapture(directory, spec)
  const { child } = await fixture({ directory, spec })
  writeFileSync(join(directory, 'mock-case.mjs'), `
    import { createServer } from 'node:net';
    import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
    import { join } from 'node:path';
    function scenario() { return 42; } scenario();
    const socket = '/tmp/cez-map-exit-' + process.pid + '.sock';
    const server = createServer(() => process.exit(0));
    server.listen(socket, () => {
      const file = join(process.env.E2E_SPEC_MAP_NODE_DIR, 'processes', process.pid + '.json');
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(file, JSON.stringify({ ...manifest, socket }));
      console.log('ready');
    });
    process.on('exit', () => {
      if (!${validReceipt}) {
        const file = join(process.env.NODE_V8_COVERAGE, 'completed-' + process.pid + '.json');
        const receipt = JSON.parse(readFileSync(file, 'utf8'));
        writeFileSync(file, JSON.stringify({ ...receipt, taskId: 'a different task' }));
      }
      try { unlinkSync(socket); } catch {}
    });
  `)
  const ready = once(child.stdout, 'data')
  child.stdin.write('seeded-task\n')
  await ready
  const capture = endNodeCapture(directory, spec)
  if (!validReceipt) { await expect(capture).rejects.toThrow(); return }
  await capture
  expect(nodeCaptureComplete(directory, spec)).toBe(true)
  expect(results(join(directory, 'exit-race/node')).find(script => script.url.endsWith('/mock-case.mjs'))?.functions)
    .toEqual(expect.arrayContaining([expect.objectContaining({ functionName: 'scenario' })]))
})
