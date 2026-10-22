import { describe, expect, it } from 'vitest'

import { voiceViewOf } from './view'

describe('voiceViewOf', () => {
  it.each([
    ['/tasks/abc', 'task'],
    ['/tasks/abc/changes', 'task'],
    ['/compare/g1', 'compare'],
    ['/new', 'new-task'],
    ['/github', 'github'],
    ['/github/prs/12', 'github'],
    ['/git', 'git'],
    ['/git/commits', 'git'],
    ['/automations/a1/log', 'automations'],
    ['/inbox', 'inbox'],
    ['/settings/agents', 'settings'],
    ['/', 'other'],
    ['/skills', 'other'],
    ['/gitlab', 'other'],
  ] as const)('reads %s as %s', (path, view) => {
    expect(voiceViewOf(path)).toBe(view)
  })
})
