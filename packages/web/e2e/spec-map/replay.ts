import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createGunzip, createGzip } from 'node:zlib'
import { parseArgs } from 'node:util'

import { merge, partial } from './build-map.ts'

interface Header { version: 1; repo: string; capture: string; commit: string }
interface RecordFile { path: string; content: string }
const REPLAY = '.ai/qa/spec-map-replay'
const SERVER = '.ai/qa/build/cezar/dist'
const SERVED = '.ai/qa/build/cezar/web/dist'

/** Only these generated evidence files enter a replay archive. */
function allowed(path: string): boolean {
  if (path.includes('\\')) return false
  if (path.split('/').some(part => !part || part === '..' || part === '.')) return false
  if (path === 'results.json') return true
  if (/^(?:server|served|sourcemaps)\//.test(path)) return /\.(?:js|map)$/.test(path)
  if (!path.startsWith('logs/') || /\/(?:processes|servers)\//.test(path)) return false
  return path.endsWith('.log') || /\/(?:coverage-.*|server-.*|shared-startup-.*|expected|expected-server-\d+|ambiguous-task-.*)\.json$/.test(path)
}

function roots(repo: string, capture: string) {
  return { logs: join(capture, 'logs'), sourcemaps: join(capture, 'sourcemaps'),
    server: join(repo, SERVER), served: join(repo, SERVED) }
}

/** Stream a bounded allowlist, never the environment, descriptor, HOME or application state. */
export async function archiveCapture(repo: string, capture: string, commit: string, out: string): Promise<void> {
  async function* records() {
    yield `${JSON.stringify({ version: 1, repo, capture, commit } satisfies Header)}\n`
    yield `${JSON.stringify({ path: 'results.json', content: readFileSync(join(capture, 'results.json')).toString('base64') })}\n`
    for (const [prefix, directory] of Object.entries(roots(repo, capture))) {
      for (const name of readdirSync(directory, { recursive: true, encoding: 'utf8' }).sort()) {
        const path = `${prefix}/${name.split('\\').join('/')}`
        if (allowed(path) && lstatSync(join(directory, name)).isFile()) yield `${JSON.stringify({ path, content: readFileSync(join(directory, name)).toString('base64') })}\n`
      }
    }
  }
  mkdirSync(dirname(out), { recursive: true })
  await pipeline(Readable.from(records()), createGzip(), createWriteStream(out))
}

function targetPath(repo: string, path: string, shard: number): string {
  const [prefix, ...parts] = path.split('/')
  const bases: Record<string, string> = { logs: `${REPLAY}/shard-${shard}/logs`, sourcemaps: `${REPLAY}/shard-${shard}/sourcemaps`, server: SERVER, served: SERVED }
  return join(repo, prefix === 'results.json' ? `${REPLAY}/shard-${shard}/results.json` : join(bases[prefix!]!, ...parts))
}

function relocate(value: unknown, before: string, after: string): unknown {
  if (typeof value === 'string') {
    const url = pathToFileURL(before).href
    if (value.startsWith(url)) return pathToFileURL(after).href + value.slice(url.length)
    return value.startsWith(before) ? after + value.slice(before.length) : value
  }
  if (Array.isArray(value)) return value.map(item => relocate(item, before, after))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item, before, after)]))
  return value
}

function replayContent(record: RecordFile, header: Header, repo: string, shard: number): Buffer {
  const bytes = Buffer.from(record.content, 'base64')
  if (!/\.(?:json|map)$/.test(record.path)) return bytes
  let data = JSON.parse(bytes.toString())
  if (record.path.endsWith('.map')) {
    const [prefix, ...parts] = record.path.split('/')
    const origin = join(roots(header.repo, header.capture)[prefix as keyof ReturnType<typeof roots>], ...parts)
    data.sources = data.sources.map((source: string) => {
      const original = resolve(dirname(origin), data.sourceRoot ?? '', source)
      const moved = relocate(original, header.repo, repo) as string
      return relative(dirname(targetPath(repo, record.path, shard)), moved)
    })
    delete data.sourceRoot
  } else data = relocate(data, header.repo, repo)
  return Buffer.from(JSON.stringify(data))
}

/** Restore into a fresh checkout's generated paths; never overwrite an existing build. */
export async function restoreCapture(archive: string, repo: string, shard = 0): Promise<Header> {
  for (const path of [ `${REPLAY}/shard-${shard}`, ...(shard === 0 ? [SERVER, SERVED] : [])]) if (existsSync(join(repo, path))) throw new Error(`replay needs a fresh generated path: ${path}`)
  const lines = createInterface({ input: createReadStream(archive).pipe(createGunzip()), crlfDelay: Infinity })
  let header: Header | undefined
  for await (const line of lines) {
    if (!header) {
      header = JSON.parse(line) as Header
      if (header.version !== 1 || !/^[0-9a-f]{40}$/.test(header.commit) || !header.repo || !header.capture) throw new Error('invalid replay header')
      continue
    }
    const record = JSON.parse(line) as RecordFile
    if (!allowed(record.path)) throw new Error(`not replay evidence: ${record.path}`)
    const file = targetPath(repo, record.path, shard)
    mkdirSync(dirname(file), { recursive: true })
    const content = replayContent(record, header, repo, shard)
    if (shard > 0 && /^(?:server|served)\//.test(record.path) && existsSync(file)) {
      if (!readFileSync(file).equals(content)) throw new Error(`shards disagree on ${record.path}`)
    } else writeFileSync(file, content, { flag: 'wx' })
  }
  if (!header) throw new Error('empty replay archive')
  return header
}

export async function rebuildCapture(archives: string[], repo: string, out: string): Promise<void> {
  let commit: string | undefined
  for (const [shard, archive] of archives.entries()) {
    const header = await restoreCapture(archive, repo, shard)
    if (commit && header.commit !== commit) throw new Error('shards name different commits')
    commit = header.commit
    const capture = join(repo, REPLAY, `shard-${shard}`)
    partial(['--logs', join(capture, 'logs'), '--node-logs', join(capture, 'logs'),
      '--served', join(repo, SERVED), '--sourcemaps', join(capture, 'sourcemaps'),
      '--results', join(capture, 'results.json'), '--out', join(repo, REPLAY, `partials/shard-${shard}.json`)], repo)
  }
  if (!commit) throw new Error('rebuild needs a capture archive')
  merge(['--partials', join(repo, REPLAY, 'partials'), '--commit', commit, '--out', out,
    '--expect', 'packages/web/src/routes/task-thread/markdown.tsx=packages/web/e2e/artifact-project-links.e2e.ts'], repo)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2)
  const { values } = parseArgs({ args, options: { repo: { type: 'string' }, capture: { type: 'string' },
    commit: { type: 'string' }, out: { type: 'string' }, archive: { type: 'string', multiple: true } } })
  if (command === 'archive' && values.repo && values.capture && values.commit && values.out) {
    await archiveCapture(resolve(values.repo), resolve(values.capture), values.commit, resolve(values.out))
  } else if (command === 'rebuild' && values.archive?.length && values.repo && values.out) {
    await rebuildCapture(values.archive.map(archive => resolve(archive)), resolve(values.repo), resolve(values.out))
  } else throw new Error('use archive --repo --capture --commit --out, or rebuild --archive --repo --out')
}
