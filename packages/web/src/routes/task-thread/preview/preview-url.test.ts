import { describe, expect, it } from 'vitest'

import type { PreviewServer } from '@open-mercato/cezar-api-client'

import { displayUrl, resolveAddress } from './preview-url'

const web = { port: 5173, command: 'x', label: 'web', registeredAt: '2026-10-02T10:00:00.000Z', answeredAtRegistration: false } as PreviewServer

describe('resolveAddress', () => {
  it('opens a registered port as that server, so its approval flow applies', () => {
    expect(resolveAddress('5173', [web])).toEqual({ kind: 'server', port: 5173 })
  })

  it('expands any other bare port to localhost', () => {
    expect(resolveAddress(' 3000 ', [web])).toEqual({ kind: 'url', url: 'http://localhost:3000' })
  })

  it('adds http:// to a host and keeps an http(s) URL as typed', () => {
    expect(resolveAddress('localhost:3000/x', [])).toEqual({ kind: 'url', url: 'http://localhost:3000/x' })
    expect(resolveAddress('example.com', [])).toEqual({ kind: 'url', url: 'http://example.com' })
    expect(resolveAddress('https://example.com/a', [])).toEqual({ kind: 'url', url: 'https://example.com/a' })
  })

  it.each(['javascript:void(0)', 'file:///etc/passwd', 'chrome://settings', 'data:text/html,<b>x</b>'])('refuses %s', input => {
    expect(resolveAddress(input, [])).toMatchObject({ kind: 'error' })
  })

  it('refuses an empty field and a port out of range', () => {
    expect(resolveAddress('  ', [])).toMatchObject({ kind: 'error' })
    expect(resolveAddress('70000', [])).toMatchObject({ kind: 'error' })
    expect(resolveAddress('0', [])).toMatchObject({ kind: 'error' })
  })

  it('refuses an address that does not parse as a URL before it reaches the pane', () => {
    expect(resolveAddress('http://[', [])).toMatchObject({ kind: 'error' })
    expect(resolveAddress('exa mple.com', [])).toMatchObject({ kind: 'error' })
  })
})

describe('displayUrl', () => {
  it('drops the scheme the toolbar does not need', () => {
    expect(displayUrl('http://localhost:5173/members')).toBe('localhost:5173/members')
  })
})
