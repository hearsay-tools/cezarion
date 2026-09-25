import { describe, expect, it } from 'vitest'

import { webhookLabel } from './webhook'

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
