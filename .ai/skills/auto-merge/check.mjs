#!/usr/bin/env node
// Decides whether a change may auto-merge. Prints QUALIFIES or DOES NOT QUALIFY,
// the size, then one line per failed rule. Exit 0 only when the change qualifies;
// an error exits 2, which counts as not qualifying.
//
// Usage: node .ai/skills/auto-merge/check.mjs --title "<PR title>" [--base <rev>] [--head <rev>]
// The head defaults to HEAD, the base to the merge base of origin/main and the head.
//
// The constants below are the policy; the rules a script cannot check are in
// SKILL.md. Tighten either by editing it. A rule change never auto-merges, because
// .ai/skills/** is on the never-list. check-history.mjs shows which merged PRs a
// changed rule would have admitted.
import { execFileSync } from 'node:child_process'
import { matchesGlob } from 'node:path'
import { parseArgs } from 'node:util'
import { checkBaselineGrowth } from '../../../.github/scripts/baseline-growth.cjs'

const MAX_FILES = 10
const MAX_LINES = 400
const BLOCKED_TYPES = new Set(['feat'])

// Paths that never auto-merge. A `source` rule skips test files. `unless` lets a
// file through when its diff only deletes ('deletes') or only adds ('adds') lines.
const NEVER = [
  { why: 'gate or test harness', globs: [
    '.github/workflows/**', '.github/codex/**', '.github/schemas/**', '.github/actionlint.yaml',
    '.github/scripts/{baseline-growth*,change-surface,change-surface-readers,automated-review,pr-readiness,require-e2e-passed,fetch-ci-results,release-*,pr-snapshot,node-floor-reporter,ci-test-sequencer,cockpit-test-sequencer,merge-recommendation*}.*',
    '.github/scripts/*.workflow.test.cjs',
    '**/vitest.config.ts', '**/vitest.setup.ts',
    'packages/web/e2e/{agent-browser,failure-setup,environment,fixture-server,held-browser-daemon,poll}.ts',
    'squeal.config.json', 'scripts/{test-changed,test-git-env}.mjs', '.ai/scripts/**', '**/tsconfig*.json',
  ] },
  { why: 'guard test change', unless: 'adds', globs: [
    'packages/cezar/src/server/{contract-parity*,route-parity,versioned-surface,bc-route-inventory,typed-bodies,api-types,origin-guard,host-guard}.test.ts',
    'packages/cezar/src/{contract-import-boundaries,contract-subpaths,test-wait-discipline,pack-check}.test.ts',
    'packages/cezar/src/test-wait-discipline.testkit.ts', 'packages/cezar/test/e2e/inline-contract.test.ts',
    'packages/web/src/test/{api-client-subpaths,e2e-wait-discipline,card-2-contrast}.test.ts', 'packages/web/src/design-guardian.test.ts',
  ] },
  { why: 'agent instructions or contracts', globs: [
    '**/AGENTS.md', '**/CLAUDE.md', 'CODE_REVIEW.md', 'SDLC.md', 'BACKWARD_COMPATIBILITY.md', 'AGENT_PROTOCOL.md',
    '.ai/specs/2026-09-04-harness-parity-matrix.md', '.ai/skills/**', '.ai/agentic.config.json', '.ai/trackers/**',
    '.ai/browsers/**', 'docs/sdlc/**', '.ai/upstream/README.md', 'packages/web/e2e/README.md', 'packages/web/docs/**',
    '{.agents,.claude,.codex,.cursor,.opencode}/**',
  ] },
  { why: 'prompt text that ships', source: true, globs: [
    'packages/cezar/src/{handoff,planner}.ts', 'packages/cezar/src/delegation/provision.ts',
    'packages/cezar/src/automations/{prompts,builtin-skill}.ts', 'packages/cezar/src/artifacts/lifecycle.ts',
    'packages/cezar/src/runs/auto-name.ts', 'packages/cezar/src/ci-wait/tools.ts',
  ] },
  { why: 'dependencies, build or release', globs: [
    '**/package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '**/package-lock.json', 'alias-cezarion/**',
    '**/.npmrc', '**/.gitattributes', '**/.gitmodules', 'CHANGELOG.md', '**/LICENSE*',
  ] },
  { why: 'build or release source', source: true, globs: [
    'scripts/release*.mjs', 'packages/cezar/src/release/**',
    'packages/cezar/scripts/{check-pack,inline-contract,sync-readme,install-as-command}.mjs',
    'packages/cezar/src/pack-check.ts', 'packages/web/vite.config.ts', 'packages/web/index.html',
  ] },
  { why: 'security', source: true, globs: [
    'packages/cezar/src/server/{capabilities,validators,upgrade-router,ws,launch-key,provider-auth-runtime,provider-action-gate,fs-browse,open-in-app,open-in-terminal,wsl}.ts',
    'packages/cezar/src/agent-config/**',
    'packages/cezar/src/core/{secret-redaction,agent-env,shell-env,provider-auth,agent-profiles,codex-permissions,opencode-permissions,codex-approvals}.ts',
    'packages/cezar/src/workspace/{agent-accounts,agent-profiles}.ts',
    'packages/cezar/src/delegation/{credentials,execution-identity,policy}.ts', 'packages/cezar/src/workflows/types.ts',
    'packages/cezar/src/server-install/**', 'packages/cezar/src/application-update/**',
    'packages/cezar/src/{skills-remote,install-as-command}.ts',
    'packages/web/src/lib/bookmarklet.ts', 'packages/web/src/api/agent-accounts.ts',
    'packages/web/src/routes/task-thread/{link-safety-dialog,task-link}.tsx',
  ] },
  { why: 'stored state or deletion', source: true, globs: [
    'packages/cezar/src/runs/{run-database,run-row,raw-record,legacy-index,store-open-error,run-claims,retention,agent-tmpdir-removal}.ts',
    'packages/cezar/src/workspace/{migrations,config}.ts', 'packages/cezar/src/paths.ts',
    'packages/cezar/src/{git-worktree-release,autosave-cleanup}.ts', 'packages/cezar/src/delegation/{scratch-cleanup,workspace}.ts',
  ] },
]

const TEST_FILE = /\.(test|spec|e2e|testkit)\.[cm]?[jt]sx?$/
const isSource = (path) => /^packages\/[^/]+\/src\//.test(path) && !TEST_FILE.test(path) && !path.includes('__fixtures__')
// Mock-only variables (CEZ_MOCK_*) configure offline test runners, not cezar.
const ENV_NAME = /CEZ_(?!MOCK_)[A-Z0-9_]+/g
const MARKER = /CEZ:[A-Z_]+/g

// Content rules: each takes the parsed diff and returns a reason, or nothing.
const CONTENT = [
  (d) => d.deletedTests.length > 0 && `deletes a test file: ${d.deletedTests.join(', ')}`,
  (d) => d.added((f) => TEST_FILE.test(f.path), /\.(skip|only|todo|fails)\b/) && 'adds .skip, .only, .todo or .fails to a test',
  (d) => d.added((f) => f.path.includes('parity'), /exempt/i) && 'adds a parity exemption',
  (d) => {
    const edited = d.files.filter((f) => matchesGlob(f.path, '**/__fixtures__/**/*.expected.*') && f.status !== 'A')
    return edited.length > 0 && `changes a golden fixture's expected output: ${edited.map((f) => f.path).join(', ')}`
  },
  (d) => d.changed((f) => f.path === '.env.example', ENV_NAME) && 'changes a CEZ_* entry in .env.example',
  (d) => {
    const changed = d.newOrGone(ENV_NAME)
    return changed.length > 0 && `adds or removes a CEZ_* variable: ${changed.join(', ')}`
  },
  (d) => d.changed((f) => f.path === 'packages/cezar/src/server/server.ts', /app\.use\(\s*['"]\/api\/\*|isLoopbackHostHeader|cors\(|localHandoff/) && 'changes the request-origin guard in server.ts',
  (d) => d.changed((f) => f.path.startsWith('packages/cezar/src/runs/') && isSource(f.path), /user_version|SCHEMA_VERSION/) && 'changes a schema version',
  (d) => {
    const changed = d.newOrGone(MARKER)
    return changed.length > 0 && `adds or removes a CEZ: marker: ${changed.join(', ')}`
  },
]

function git(...args) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 256 << 20, stdio: 'pipe' })
}

function names(lines, pattern) {
  return [...new Set(lines.flatMap((l) => l.match(pattern) ?? []))]
}

function parseDiff(base, head) {
  // --raw -z: ":<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0" per file.
  const files = new Map()
  const raw = git('diff', '--raw', '--no-renames', '-z', base, head).split('\0')
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const [oldMode, newMode, , , status] = raw[i].slice(1).split(' ')
    files.set(raw[i + 1], { path: raw[i + 1], status, oldMode, newMode, adds: [], dels: [] })
  }
  let file = null
  let inHunk = false
  for (const line of git('diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', base, head).split('\n')) {
    if (line.startsWith('diff --git a/')) {
      // With --no-renames both sides name the same path: "diff --git a/<p> b/<p>".
      file = files.get(line.slice(13, 13 + (line.length - 16) / 2)) ?? null
      inHunk = false
    } else if (line.startsWith('@@')) inHunk = true
    else if (file && inHunk && line.startsWith('+')) file.adds.push(line.slice(1))
    else if (file && inHunk && line.startsWith('-')) file.dels.push(line.slice(1))
  }
  const list = [...files.values()]
  const lines = (which, test) => list.filter(test).flatMap((f) => f[which])
  // A /g pattern keeps lastIndex between test() calls, so test with a copy without it.
  const matches = (re) => (l) => new RegExp(re.source, re.flags.replace('g', '')).test(l)
  return {
    files: list,
    // Renames are not deletions: -M reports a moved test file as R, not D.
    deletedTests: git('diff', '--name-only', '--diff-filter=D', '-M', base, head).split('\n').filter((p) => TEST_FILE.test(p)),
    lines,
    added: (test, re) => lines('adds', test).some(matches(re)),
    changed: (test, re) => [...lines('adds', test), ...lines('dels', test)].some(matches(re)),
    // Names in changed source lines that the base source never had, or the head source no longer has.
    newOrGone(pattern) {
      const at = (rev) => {
        let out = ''
        try {
          out = git('grep', '-h', '-o', '-P', pattern.source, rev, '--', 'packages', ':!**/*.test.*', ':!**/__fixtures__/**')
        } catch (error) {
          if (error.status !== 1) throw error // 1 means no match
        }
        return new Set(out.split('\n'))
      }
      const inSource = (f) => isSource(f.path)
      const added = names(lines('adds', inSource), pattern)
      const removed = names(lines('dels', inSource), pattern)
      const before = added.length > 0 ? at(base) : new Set()
      const after = removed.length > 0 ? at(head) : new Set()
      return [...added.filter((n) => !before.has(n)), ...removed.filter((n) => !after.has(n))]
    },
  }
}

function pathReasons(diff) {
  const reasons = []
  for (const f of diff.files) {
    if (f.status === 'A' && f.path.endsWith('.baseline.json')) reasons.push(`new ratchet baseline: ${f.path}`)
    if ([f.oldMode, f.newMode].some((m) => m === '120000' || m === '160000')) reasons.push(`symlink or submodule: ${f.path}`)
    else if (f.status === 'M' && f.oldMode !== f.newMode) reasons.push(`changes the file mode: ${f.path}`)
    for (const rule of NEVER) {
      if (rule.source && TEST_FILE.test(f.path)) continue
      if (!rule.globs.some((g) => matchesGlob(f.path, g))) continue
      if (rule.unless === 'deletes' && f.adds.length === 0) continue
      if (rule.unless === 'adds' && f.dels.length === 0) continue
      reasons.push(`${rule.why}: ${f.path}`)
    }
  }
  return reasons
}

function check({ title, base, head }) {
  const reasons = []
  const type = /^(\w+)(\([^)]*\))?(!)?: \S/.exec(title ?? '')
  if (!type) reasons.push('the title is not a Conventional Commits title')
  else if (BLOCKED_TYPES.has(type[1])) reasons.push(`the title type is ${type[1]}`)
  else if (type[3]) reasons.push('the title marks a breaking change (!)')

  // -M counts a rename once, as GitHub does. A binary file shows '-' for its counts.
  const numstat = git('diff', '--numstat', '-M', base, head).split('\n').filter(Boolean).map((l) => l.split('\t'))
  const lines = numstat.reduce((sum, [a, d]) => sum + (Number(a) || 0) + (Number(d) || 0), 0)
  if (numstat.length > MAX_FILES) reasons.push(`changes ${numstat.length} files (limit ${MAX_FILES})`)
  if (lines > MAX_LINES) reasons.push(`changes ${lines} lines (limit ${MAX_LINES})`)
  for (const [a, , path] of numstat) if (a === '-') reasons.push(`binary file: ${path}`)

  reasons.push(...checkBaselineGrowth({ base, head }).map(reason => `ratchet baseline growth: ${reason}`))

  const diff = parseDiff(base, head)
  reasons.push(...pathReasons(diff))
  for (const rule of CONTENT) {
    const reason = rule(diff)
    if (reason) reasons.push(reason)
  }
  return { qualifies: reasons.length === 0, files: numstat.length, lines, reasons }
}

try {
  const { values } = parseArgs({ options: { title: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' } } })
  const head = values.head ?? 'HEAD'
  const base = values.base ?? git('merge-base', 'origin/main', head).trim()
  const result = check({ title: values.title, base, head })
  console.log(result.qualifies ? 'QUALIFIES' : 'DOES NOT QUALIFY')
  console.log(`${result.files} files, ${result.lines} lines`)
  for (const reason of result.reasons) console.log(`- ${reason}`)
  process.exit(result.qualifies ? 0 : 1)
} catch (error) {
  console.log('DOES NOT QUALIFY')
  console.log(`- the check failed: ${String(error.stderr || error.message).trim().split('\n')[0]}`)
  process.exit(2)
}
