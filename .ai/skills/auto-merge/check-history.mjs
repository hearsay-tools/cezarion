#!/usr/bin/env node
// Runs check.mjs on merged pull requests, to see what a rule change would have
// admitted. Prints how many qualify and how often each rule blocked one.
//
// Usage: node .ai/skills/auto-merge/check-history.mjs [--limit 1000] [--json <out.json>]
// Run `git fetch origin main` first: each PR is checked as its squash commit
// against that commit's parent, so the commits must be local.
import { execFile, execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'

const run = promisify(execFile)
const checkScript = fileURLToPath(new URL('./check.mjs', import.meta.url))
const { values } = parseArgs({ options: { limit: { type: 'string', default: '1000' }, json: { type: 'string' } } })

const prs = JSON.parse(execFileSync('gh', [
  'pr', 'list', '--state', 'merged', '--base', 'main', '--limit', values.limit, '--json', 'number,title,mergeCommit',
], { encoding: 'utf8', maxBuffer: 64 << 20 })).filter((pr) => pr.mergeCommit)

async function checkOne({ number, title, mergeCommit }) {
  const sha = mergeCommit.oid
  let stdout
  let code = 0
  try {
    ;({ stdout } = await run(process.execPath, [checkScript, '--title', title, '--base', `${sha}^1`, '--head', sha], { maxBuffer: 64 << 20 }))
  } catch (error) {
    ;({ stdout, code } = error)
  }
  const lines = String(stdout).trim().split('\n')
  return { number, title, code, size: lines[1], reasons: lines.slice(2).map((l) => l.replace(/^- /, '')) }
}

const rows = []
const queue = [...prs]
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length > 0) rows.push(await checkOne(queue.shift()))
}))
rows.sort((a, b) => b.number - a.number)

// A reason's rule is the text before its first ': ' (the path or names follow it).
const blocked = new Map()
for (const row of rows) {
  for (const rule of new Set(row.reasons.map((r) => r.split(': ')[0].replace(/^changes \d+ (files|lines).*/, 'changes too many $1')))) {
    blocked.set(rule, (blocked.get(rule) ?? 0) + 1)
  }
}
console.log(`${rows.filter((r) => r.code === 0).length} of ${rows.length} merged PRs qualify; ${rows.filter((r) => r.code === 2).length} checks failed.`)
for (const [rule, count] of [...blocked].sort((a, b) => b[1] - a[1])) console.log(`${String(count).padStart(5)}  ${rule}`)
if (values.json) writeFileSync(values.json, `${JSON.stringify(rows, null, 1)}\n`)
