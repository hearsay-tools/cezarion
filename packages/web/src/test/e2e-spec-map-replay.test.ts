// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { archiveCapture, rebuildCapture } from '../../e2e/spec-map/replay'

it('rebuilds browser and server evidence from an allowlisted raw archive in a fresh checkout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-map-replay-'))
  const original = join(root, 'original')
  const target = join(root, 'checkout')
  const capture = join(root, 'capture')
  const put = (file: string, content: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content) }
  try {
    const spec = 'packages/web/e2e/artifact-project-links.e2e.ts'
    for (const repo of [original, target]) {
      put(join(repo, spec), '')
      put(join(repo, 'packages/web/src/routes/task-thread/markdown.tsx'), 'export const x = 1')
      put(join(repo, 'packages/cezar/src/a.ts'), 'export function used() {}')
    }
    execFileSync('git', ['init', '-q'], { cwd: target })
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--no-gpg-sign', '--allow-empty', '-qm', 'fixture'], { cwd: target })
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf8' }).trim()
    const served = join(original, '.ai/qa/build/cezar/web/dist/assets/x.js')
    const mapped = join(capture, 'sourcemaps/assets/x.js')
    const code = 'function used(){return 1}\n'
    put(served, code)
    put(mapped, code)
    put(`${mapped}.map`, JSON.stringify({ version: 3, names: [], mappings: 'AAAA',
      sources: [relative(dirname(mapped), join(original, 'packages/web/src/routes/task-thread/markdown.tsx'))] }))
    const server = join(original, '.ai/qa/build/cezar/dist/a.js')
    put(server, code)
    put(`${server}.map`, JSON.stringify({ version: 3, names: [], mappings: 'AAAA',
      sources: [relative(dirname(server), join(original, 'packages/cezar/src/a.ts'))] }))
    put(join(capture, 'results.json'), JSON.stringify({ testResults: [{ name: join(original, spec), status: 'passed' }] }))
    put(join(capture, 'logs/artifact-project-links/v8.log'), 'script-details,1,http://localhost/assets/x.js,0,0,\nfunction,first-execution,1,1,20,0.1,1,used\n')
    put(join(capture, 'logs/shared-startup-1.json'), JSON.stringify({ result: [{ url: pathToFileURL(server).href,
      functions: [{ ranges: [{ startOffset: 0, endOffset: code.length, count: 1 }] }] }] }))
    put(join(capture, 'logs/artifact-project-links/node/server-1-0.json'), '{"result":[]}')
    put(join(capture, 'logs/.env'), 'must stay out')
    put(join(capture, 'logs/control.json'), '{"must":"stay out"}')
    const archive = join(root, 'capture.jsonl.gz')
    await archiveCapture(original, capture, commit, archive)
    const raw = gunzipSync(readFileSync(archive)).toString()
    expect(raw).not.toContain('must stay out')
    expect(raw).not.toContain('logs/.env')
    expect(raw).not.toContain('logs/control.json')
    const out = join(root, 'map.json')
    const wrongCommit = join(root, 'wrong.jsonl.gz')
    writeFileSync(wrongCommit, gzipSync(raw.replace(commit, 'a'.repeat(40))))
    await expect(rebuildCapture([wrongCommit], target, out)).rejects.toThrow('checkout differs')
    const missingFile = join(root, 'missing.jsonl.gz')
    writeFileSync(missingFile, gzipSync(raw.split('\n').filter(line => !line.includes('server/a.js.map')).join('\n')))
    await expect(rebuildCapture([archive, missingFile], target, out)).rejects.toThrow('different shared file inventories')
    rmSync(join(target, '.ai'), { recursive: true, force: true })
    await rebuildCapture([archive], target, out)
    const map = JSON.parse(readFileSync(out, 'utf8'))
    expect(map.specs).toEqual([spec])
    expect(map.incomplete).toEqual([])
    expect(map.functions['packages/cezar/src/a.ts']).toEqual([{ start: 1, end: 1, specs: [0] }])
    expect(map.sources['packages/web/src/routes/task-thread/markdown.tsx']).toEqual([0])
    await expect(rebuildCapture([archive], target, out)).rejects.toThrow('fresh generated path')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
