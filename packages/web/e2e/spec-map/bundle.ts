import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'

/**
 * The served cockpit bundle and the source maps that name its repository files
 * (hearsay-tools/cezarion#1816).
 *
 * The e2e build has no source maps. The capture job builds the cockpit a second time with
 * `vite build --sourcemap hidden`, which writes the same JavaScript plus a `.map` beside each
 * file. Those maps describe the served bundle only when the JavaScript is the same byte for byte,
 * so `assertSameJavaScript` checks that before any map is read.
 */

/** Every `.js` file under `dir`, relative to it, with `/` separators. */
export function javaScriptFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.js'))
    .map((file) => file.split(sep).join('/'))
    .sort()
}

/** Throws, naming each file, unless both directories hold the same JavaScript byte for byte. */
export function assertSameJavaScript(served: string, sourcemapped: string): void {
  const servedFiles = javaScriptFiles(served)
  const mappedFiles = new Set(javaScriptFiles(sourcemapped))
  const problems: string[] = []
  for (const file of servedFiles) {
    if (!mappedFiles.delete(file)) problems.push(`${file}: missing from the source-map build`)
    else if (!readFileSync(join(served, file)).equals(readFileSync(join(sourcemapped, file)))) {
      problems.push(`${file}: differs from the source-map build`)
    }
  }
  for (const file of mappedFiles) problems.push(`${file}: in the source-map build but not served`)
  if (servedFiles.length === 0) problems.push(`no JavaScript under ${served}`)
  if (problems.length > 0) {
    throw new Error(
      'The source-map build does not match the served bundle, so its maps would name the wrong files:\n  ' +
        problems.join('\n  '),
    )
  }
}

/** A source the map names, as a repository path, or null for a dependency or a generated file. */
function repositoryPath(repoRoot: string, resolved: string | null): string | null {
  if (!resolved) return null
  const path = relative(repoRoot, resolved).split(sep).join('/')
  if (!path.startsWith('packages/') || path.includes('/node_modules/')) return null
  return path
}

interface Script {
  lineStarts: number[]
  map: TraceMap
  sources: string[]
}

export class Bundle {
  private readonly scripts = new Map<string, Script | null>()
  private readonly served: string
  private readonly sourcemapped: string
  private readonly repoRoot: string

  /** `served` is the directory the cockpit is served from; `sourcemapped` holds the same files with maps. */
  constructor(served: string, sourcemapped: string, repoRoot: string) {
    this.served = served
    this.sourcemapped = sourcemapped
    this.repoRoot = repoRoot
  }

  private script(pathname: string): Script | null {
    const cached = this.scripts.get(pathname)
    if (cached !== undefined) return cached
    const file = join(this.served, pathname)
    const mapFile = join(this.sourcemapped, `${pathname}.map`)
    let script: Script | null = null
    if (pathname.endsWith('.js') && existsSync(file) && existsSync(mapFile)) {
      const code = readFileSync(file, 'utf8')
      const lineStarts = [0]
      for (let at = code.indexOf('\n'); at !== -1; at = code.indexOf('\n', at + 1)) lineStarts.push(at + 1)
      const map = new TraceMap(readFileSync(mapFile, 'utf8'), mapFile)
      const sources = map.resolvedSources.map((source) => repositoryPath(this.repoRoot, source))
      script = { lineStarts, map, sources: [...new Set(sources.filter((path) => path !== null))] }
    }
    this.scripts.set(pathname, script)
    return script
  }

  /** Whether `pathname` (a URL path such as `/assets/index-abc.js`) is a mapped script of this bundle. */
  has(pathname: string): boolean {
    return this.script(pathname) !== null
  }

  /** The repository files a served script was built from. */
  sourcesOf(pathname: string): string[] {
    return this.script(pathname)?.sources ?? []
  }

  /** The repository file that holds character `offset` of a served script, or null. */
  sourceAt(pathname: string, offset: number): string | null {
    const script = this.script(pathname)
    if (!script) return null
    let low = 0
    let high = script.lineStarts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if ((script.lineStarts[middle] ?? 0) <= offset) low = middle
      else high = middle - 1
    }
    const column = offset - (script.lineStarts[low] ?? 0)
    const { source } = originalPositionFor(script.map, { line: low + 1, column })
    return repositoryPath(this.repoRoot, source)
  }
}
