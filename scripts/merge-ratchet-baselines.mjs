import { readFileSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual as equal } from 'node:util'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const numeric = value => Number.isSafeInteger(value) && value >= 0
const fail = () => { throw new Error('Unsupported or conflicting ratchet baseline; resolve manually') }
const identity = site => JSON.stringify([site.file, site.rule, site.site])

function exactKeys(value, keys) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) fail()
}

function validate(value) {
  if (!object(value) || typeof value.$comment !== 'string') fail()
  if (Object.hasOwn(value, 'files')) {
    exactKeys(value, ['$comment', 'limit', 'files'])
    if (!numeric(value.limit) || !object(value.files) || !Object.values(value.files).every(numeric)) fail()
    return 'files'
  }
  exactKeys(value, ['$comment', 'sites'])
  if (!Array.isArray(value.sites)) fail()
  const seen = new Set()
  for (const site of value.sites) {
    exactKeys(site, ['file', 'rule', 'site', 'count'])
    if (![site.file, site.rule, site.site].every(part => typeof part === 'string') || !numeric(site.count)) fail()
    const key = identity(site)
    if (seen.has(key)) fail()
    seen.add(key)
  }
  return 'sites'
}

function metadata(base, ours, theirs) {
  if (equal(ours, theirs)) return ours
  if (equal(ours, base)) return theirs
  if (equal(theirs, base)) return ours
  return fail()
}

/** Missing base keys are additions; missing existing keys are removals, never a union. */
function mergeCounts(base, ours, theirs) {
  const result = new Map()
  const keys = [...new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])].sort()
  for (const key of keys) {
    const before = base.get(key)
    const left = ours.get(key)
    const right = theirs.get(key)
    if (left !== undefined && right !== undefined) result.set(key, Math.min(left, right))
    else if (before === undefined) result.set(key, left ?? right)
    else if (left !== undefined || right !== undefined) {
      if ((left ?? right) !== before) fail()
      // One side removed the entry, the other left it unchanged: keep the removal.
    }
  }
  return result
}

function counts(value, kind) {
  return kind === 'files'
    ? new Map(Object.entries(value.files))
    : new Map(value.sites.map(site => [identity(site), site.count]))
}

export function mergeBaseline(base, ours, theirs) {
  const kind = validate(base)
  if (validate(ours) !== kind || validate(theirs) !== kind) fail()
  const $comment = metadata(base.$comment, ours.$comment, theirs.$comment)
  const merged = mergeCounts(...[base, ours, theirs].map(value => counts(value, kind)))
  if (kind === 'files') {
    return { $comment, limit: metadata(base.limit, ours.limit, theirs.limit), files: Object.fromEntries(merged) }
  }
  const sites = [...merged].map(([key, count]) => {
    const [file, rule, site] = JSON.parse(key)
    return { file, rule, site, count }
  })
  return { $comment, sites }
}

// Git supplies base, ours (also the output), theirs. Validate everything before writing.
if (import.meta.main) {
  try {
    if (process.argv.length !== 5) fail()
    const [base, ours, theirs] = process.argv.slice(2).map(path => JSON.parse(readFileSync(path, 'utf8')))
    const merged = mergeBaseline(base, ours, theirs)
    writeFileSync(process.argv[3], JSON.stringify(merged, null, 2) + '\n')
  } catch (error) {
    console.error(`Ratchet merge: ${error.message}`)
    process.exitCode = 1
  }
}
