import { describe, expect, it } from 'vitest'

import { taskWebhooks, webhookLabel, webhookNames } from './webhook'

describe('webhookLabel', () => {
  it('names host and path, never the query or credentials', () => {
    expect(webhookLabel('https://bot.example/hooks/cez')).toBe('bot.example/hooks/cez')
    expect(webhookLabel('https://user:pw@bot.example/hooks/?key=secret')).toBe('bot.example/hooks')
    expect(webhookLabel('http://127.0.0.1:9000/')).toBe('127.0.0.1:9000')
  })

  it('falls back to the input when it does not parse', () => {
    expect(webhookLabel('not a url')).toBe('not a url')
  })
})

// hearsay-tools/cezarion#1576
describe('taskWebhooks', () => {
  const hook = (id: string, tasks: boolean) => ({ id, name: id.toUpperCase(), url: `https://bot.example/${id}`, tokenSet: false, tasks, agent: !tasks })

  it('keeps the webhooks with task notifications on, in order', () => {
    expect(taskWebhooks({ webhooks: [hook('a', true), hook('b', false), hook('c', true)] }).map((target) => target.id)).toEqual(['a', 'c'])
  })

  it('reads the single legacy webhook as one unnamed task webhook', () => {
    expect(taskWebhooks({ webhook: { url: 'https://bot.example/x', tokenSet: true } })).toEqual([
      { id: 'task-webhook', name: 'Task webhook', url: 'https://bot.example/x' },
    ])
    expect(taskWebhooks({})).toEqual([])
    expect(taskWebhooks(undefined)).toEqual([])
  })

  it('names one, two, three and more targets', () => {
    const named = (...names: string[]) => webhookNames(names.map((name) => ({ id: name, name, url: '' })))
    expect(named('A')).toBe('A')
    expect(named('A', 'B')).toBe('A and B')
    expect(named('A', 'B', 'C')).toBe('A, B and C')
    expect(named('A', 'B', 'C', 'D')).toBe('A, B and 2 more')
  })
})
