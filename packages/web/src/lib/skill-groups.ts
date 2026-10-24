import type { Skill, TeamSkillRef } from '@open-mercato/cezar-api-client'

import { queryScore } from './skills'

/**
 * The grouped Skills table (hearsay-tools/cezarion#1607): repository → plugin or directory →
 * skill. Pure, so the page and its tests read the same rules.
 *
 * Team skills group by their source repository, then by where the skill sits in that
 * repository. Local, global and built-in skills each get one locked top-level group: they are
 * always enabled, so their group has no activation control.
 */

export type SkillGroupKind = 'source' | 'repo' | 'plugin' | 'directory'

export interface SkillTreeGroup<T> {
  /** Unique across the tree; the fold state is keyed by it. */
  key: string
  label: string
  kind: SkillGroupKind
  /** Local, global and built-in skills: always enabled, no group switch. */
  locked: boolean
  /** Skills directly in this group, in the order given. */
  items: T[]
  /** Plugin or directory groups, by label. */
  children: SkillTreeGroup<T>[]
}

type Entry = { skill: Skill; key: string }

/** The folder chains that only hold skills, removed before a path names a directory group. */
const CONTAINERS: readonly (readonly string[])[] = [
  ['.ai', 'cezar', 'skills'],
  ['.ai', 'skills'],
  ['.claude', 'skills'],
  ['.agents', 'skills'],
  ['skills'],
]

/**
 * The plugin or directory a team skill sits in, from its path inside the repository
 * (`team.path`), or null when it sits directly under the repository. The skill's own part is
 * removed first: `<dir>/SKILL.md`, `commands/<name>.md`, or the Markdown file. A path under
 * `plugins/<name>/` names that plugin; any other folder left after the skill containers is the
 * directory group.
 */
export function skillGroupOf(path: string): { kind: 'plugin' | 'directory'; name: string } | null {
  const dirs = path.split('/').slice(0, -1)
  if (path === 'SKILL.md' || path.endsWith('/SKILL.md')) dirs.pop()
  else if (dirs.at(-1) === 'commands') dirs.pop()
  if (dirs[0] === 'plugins' && dirs[1]) return { kind: 'plugin', name: dirs[1] }
  for (const chain of CONTAINERS) {
    const at = indexOfChain(dirs, chain)
    if (at === -1) continue
    // A trailing `skills` is a container; a `skills` folder in the middle names nothing either.
    if (chain.length > 1 || at === dirs.length - 1) {
      dirs.splice(at, chain.length)
      break
    }
  }
  return dirs.length > 0 ? { kind: 'directory', name: dirs.join('/') } : null
}

function indexOfChain(dirs: readonly string[], chain: readonly string[]): number {
  for (let at = dirs.length - chain.length; at >= 0; at--) {
    if (chain.every((part, offset) => dirs[at + offset] === part)) return at
  }
  return -1
}

const SOURCE_GROUPS = [
  { id: 'project', label: 'This project', sources: new Set<Skill['source']>(['ai', 'cezar', 'agents']) },
  { id: 'global', label: 'Global', sources: new Set<Skill['source']>(['global']) },
  { id: 'builtin', label: 'Built-in', sources: new Set<Skill['source']>(['builtin']) },
] as const

const group = <T,>(key: string, label: string, kind: SkillGroupKind, locked: boolean): SkillTreeGroup<T> => ({
  key,
  label,
  kind,
  locked,
  items: [],
  children: [],
})

/**
 * Build the tree. Top level: This project, every team repository (by name), Global, Built-in.
 * Empty groups are left out. Items keep the order given, so the caller's sort holds inside
 * each group.
 */
export function buildSkillTree<T extends Entry>(entries: readonly T[]): SkillTreeGroup<T>[] {
  const sources = SOURCE_GROUPS.map((source) => group<T>(`source\u0000${source.id}`, source.label, 'source', true))
  const repos = new Map<string, SkillTreeGroup<T>>()
  for (const entry of entries) {
    const { skill } = entry
    if (!skill.team) {
      const at = SOURCE_GROUPS.findIndex((source) => source.sources.has(skill.source))
      sources[at === -1 ? 0 : at]!.items.push(entry)
      continue
    }
    const { repo, path } = skill.team
    let parent = repos.get(repo)
    if (!parent) {
      parent = group<T>(`repo\u0000${repo}`, repo, 'repo', false)
      repos.set(repo, parent)
    }
    const sub = skillGroupOf(path)
    if (!sub) {
      parent.items.push(entry)
      continue
    }
    const key = `${parent.key}\u0000${sub.kind}\u0000${sub.name}`
    let child = parent.children.find((candidate) => candidate.key === key)
    if (!child) {
      child = group<T>(key, sub.name, sub.kind, false)
      parent.children.push(child)
    }
    child.items.push(entry)
  }
  for (const repo of repos.values()) repo.children.sort((a, b) => a.label.localeCompare(b.label))
  const teamGroups = [...repos.values()].sort((a, b) => a.label.localeCompare(b.label))
  return [sources[0]!, ...teamGroups, sources[1]!, sources[2]!].filter(
    (candidate) => candidate.items.length > 0 || candidate.children.length > 0,
  )
}

/** Every group key in the tree, parents before their children. */
export function treeGroupKeys<T>(tree: readonly SkillTreeGroup<T>[]): string[] {
  return tree.flatMap((node) => [node.key, ...treeGroupKeys(node.children)])
}

/** Every skill of a group, its nested groups included. */
export function groupItems<T>(node: SkillTreeGroup<T>): T[] {
  return [...node.items, ...node.children.flatMap(groupItems)]
}

export interface GroupActivation {
  enabled: number
  total: number
  state: 'on' | 'off' | 'mixed'
  /** The switch keys a group control writes: every team child, filtered ones included. */
  refs: TeamSkillRef[]
}

/** The enabled count and state of a group. A locked group is always fully on. */
export function groupActivation<T extends Entry>(
  node: SkillTreeGroup<T>,
  isOn: (skill: Skill) => boolean,
): GroupActivation {
  const items = groupItems(node)
  if (node.locked) return { enabled: items.length, total: items.length, state: 'on', refs: [] }
  const refs: TeamSkillRef[] = []
  let enabled = 0
  for (const { skill } of items) {
    if (!skill.team) continue
    refs.push({ repo: skill.team.repo, name: skill.name })
    if (isOn(skill)) enabled++
  }
  const state = enabled === 0 ? 'off' : enabled === refs.length ? 'on' : 'mixed'
  return { enabled, total: refs.length, state, refs }
}

/**
 * The keys of every skill the query matches, or null for an empty query. Every word must
 * match the skill's name, description, repository or group (the `queryScore` rule the other
 * skill searches use).
 */
export function matchingSkillKeys<T extends Entry>(tree: readonly SkillTreeGroup<T>[], query: string): Set<string> | null {
  if (query.trim() === '') return null
  const matches = new Set<string>()
  const walk = (node: SkillTreeGroup<T>, labels: string[]) => {
    const context = [...labels, node.label]
    for (const { skill, key } of node.items) {
      const haystack = [skill.description ?? '', ...context].join(' ')
      if (queryScore(skill.name, haystack, query) > 0) matches.add(key)
    }
    for (const child of node.children) walk(child, context)
  }
  for (const node of tree) walk(node, [])
  return matches
}

/** The group keys to open so every listed skill shows: each one's ancestors. */
export function revealKeys<T extends Entry>(tree: readonly SkillTreeGroup<T>[], skillKeys: ReadonlySet<string>): string[] {
  const keys: string[] = []
  const walk = (node: SkillTreeGroup<T>, path: string[]): boolean => {
    const here = [...path, node.key]
    let hit = node.items.some((entry) => skillKeys.has(entry.key))
    if (hit) keys.push(...here.filter((key) => !keys.includes(key)))
    for (const child of node.children) hit = walk(child, here) || hit
    return hit
  }
  for (const node of tree) walk(node, [])
  return keys
}
