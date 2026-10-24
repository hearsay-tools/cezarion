import { describe, expect, it } from 'vitest'

import type { Skill } from '@open-mercato/cezar-api-client'
import {
  buildSkillTree,
  groupActivation,
  matchingSkillKeys,
  revealKeys,
  skillGroupOf,
  treeGroupKeys,
  type SkillTreeGroup,
} from './skill-groups'

const local = (name: string, source: Skill['source'] = 'ai'): Skill => ({
  name,
  source,
  body: '',
  path: `.ai/skills/${name}.md`,
})

const team = (name: string, path: string, repo = 'acme/skills', description?: string): Skill => ({
  name,
  source: 'team',
  body: '',
  path: `${repo}@main:${path}`,
  team: { repo, ref: 'main', path, dir: path.endsWith('SKILL.md') },
  ...(description ? { description } : {}),
})

type Item = { skill: Skill; key: string }
const item = (skill: Skill): Item => ({ skill, key: `${skill.team?.repo ?? skill.source}:${skill.name}` })

const names = (group: SkillTreeGroup<Item>) => group.items.map((entry) => entry.skill.name)

describe('skillGroupOf', () => {
  it.each([
    ['plugins/sdlc/skills/dev-flow/SKILL.md', { kind: 'plugin', name: 'sdlc' }],
    ['plugins/sdlc/commands/ship.md', { kind: 'plugin', name: 'sdlc' }],
    ['dev-flow/SKILL.md', null],
    ['skills/dev-flow/SKILL.md', null],
    ['.claude/skills/dev-flow/SKILL.md', null],
    ['.agents/skills/dev-flow/SKILL.md', null],
    ['commands/ship.md', null],
    ['.ai/skills/ship.md', null],
    ['.ai/cezar/skills/ship.md', null],
    ['.ai/skills/release/ship.md', { kind: 'directory', name: 'release' }],
    ['frontend/skills/lint/SKILL.md', { kind: 'directory', name: 'frontend' }],
    ['tools/qa/lint/SKILL.md', { kind: 'directory', name: 'tools/qa' }],
    ['tools/commands/ship.md', { kind: 'directory', name: 'tools' }],
    ['SKILL.md', null],
  ])('%s → %o', (path, expected) => {
    expect(skillGroupOf(path)).toEqual(expected)
  })
})

describe('buildSkillTree', () => {
  it('groups by source repository, then by plugin or directory, and keeps the item order', () => {
    const tree = buildSkillTree([
      item(local('om-fix')),
      item(team('lint', 'frontend/skills/lint/SKILL.md')),
      item(team('dev-flow', 'plugins/sdlc/skills/dev-flow/SKILL.md')),
      item(team('root-skill', 'root-skill/SKILL.md')),
      item(team('plan', 'plugins/sdlc/skills/plan/SKILL.md')),
      item(team('other', 'other/SKILL.md', 'beta/skills')),
      item(local('zebra', 'global')),
      item(local('create-automation', 'builtin')),
      item(local('om-review', 'cezar')),
    ])
    expect(tree.map((group) => [group.kind, group.label])).toEqual([
      ['source', 'This project'],
      ['repo', 'acme/skills'],
      ['repo', 'beta/skills'],
      ['source', 'Global'],
      ['source', 'Built-in'],
    ])
    expect(names(tree[0]!)).toEqual(['om-fix', 'om-review'])
    const acme = tree[1]!
    expect(names(acme)).toEqual(['root-skill'])
    expect(acme.children.map((group) => [group.kind, group.label, names(group)])).toEqual([
      ['directory', 'frontend', ['lint']],
      ['plugin', 'sdlc', ['dev-flow', 'plan']],
    ])
    expect(acme.children[1]!.key).toBe('repo\u0000acme/skills\u0000plugin\u0000sdlc')
  })

  it('locks the local, global and built-in groups and leaves team repositories switchable', () => {
    const tree = buildSkillTree([item(local('a')), item(team('b', 'b/SKILL.md'))])
    expect(tree.map((group) => group.locked)).toEqual([true, false])
  })

  it('treeGroupKeys lists every group, nested ones included', () => {
    const tree = buildSkillTree([item(team('dev-flow', 'plugins/sdlc/skills/dev-flow/SKILL.md'))])
    expect(treeGroupKeys(tree)).toEqual(['repo\u0000acme/skills', 'repo\u0000acme/skills\u0000plugin\u0000sdlc'])
  })
})

describe('groupActivation', () => {
  const tree = buildSkillTree([
    item(team('a', 'plugins/p/skills/a/SKILL.md')),
    item(team('b', 'plugins/p/skills/b/SKILL.md')),
    item(team('c', 'c/SKILL.md')),
  ])
  const repo = tree[0]!
  const plugin = repo.children[0]!

  it('counts every eligible child and names the state', () => {
    expect(groupActivation(plugin, () => true)).toMatchObject({ enabled: 2, total: 2, state: 'on' })
    expect(groupActivation(plugin, (skill) => skill.name === 'a')).toMatchObject({ enabled: 1, total: 2, state: 'mixed' })
    expect(groupActivation(repo, () => false)).toMatchObject({ enabled: 0, total: 3, state: 'off' })
  })

  it('lists the refs of every child, nested groups included', () => {
    expect(groupActivation(repo, () => true).refs).toEqual([
      { repo: 'acme/skills', name: 'c' },
      { repo: 'acme/skills', name: 'a' },
      { repo: 'acme/skills', name: 'b' },
    ])
  })

  it('a locked group counts every skill as enabled and has no refs', () => {
    const [project] = buildSkillTree([item(local('x')), item(local('y'))])
    expect(groupActivation(project!, () => false)).toEqual({ enabled: 2, total: 2, state: 'on', refs: [] })
  })
})

describe('search', () => {
  const entries = [
    item(team('dev-flow', 'plugins/sdlc/skills/dev-flow/SKILL.md', 'acme/skills', 'Work a ticket')),
    item(team('lint', 'frontend/skills/lint/SKILL.md')),
    item(local('om-fix')),
  ]
  const tree = buildSkillTree(entries)

  it('matches the name, the description, the repository and the group', () => {
    expect(matchingSkillKeys(tree, '')).toBeNull()
    expect([...matchingSkillKeys(tree, 'lint')!]).toEqual(['acme/skills:lint'])
    expect([...matchingSkillKeys(tree, 'ticket')!]).toEqual(['acme/skills:dev-flow'])
    expect([...matchingSkillKeys(tree, 'sdlc')!]).toEqual(['acme/skills:dev-flow'])
    expect([...matchingSkillKeys(tree, 'acme')!].sort()).toEqual(['acme/skills:dev-flow', 'acme/skills:lint'])
    expect([...matchingSkillKeys(tree, 'this project')!]).toEqual(['ai:om-fix'])
  })

  it('revealKeys names every ancestor group of the given skills', () => {
    expect(revealKeys(tree, new Set(['acme/skills:dev-flow']))).toEqual([
      'repo\u0000acme/skills',
      'repo\u0000acme/skills\u0000plugin\u0000sdlc',
    ])
    expect(revealKeys(tree, new Set(['ai:om-fix']))).toEqual(['source\u0000project'])
  })
})
