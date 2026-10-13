import { describe, expect, it } from 'vitest'

import { fullExecCommand, quoteExecArg } from './exec-command'

describe('fullExecCommand', () => {
  it('returns a string command verbatim', () => {
    const command = 'echo hello && echo world'
    expect(fullExecCommand({ command })).toBe(command)
  })

  it('quotes argv members that contain spaces', () => {
    expect(fullExecCommand({ command: ['printf', 'hello world'] })).toBe(
      `printf \u0027hello world\u0027`,
    )
  })

  it('returns undefined when command input is missing', () => {
    expect(fullExecCommand(undefined)).toBeUndefined()
    expect(fullExecCommand({})).toBeUndefined()
    expect(fullExecCommand({ description: 'run tests' })).toBeUndefined()
  })
})

describe('quoteExecArg', () => {
  it('leaves safe tokens unquoted', () => {
    expect(quoteExecArg('--flag')).toBe('--flag')
    expect(quoteExecArg('/tmp/a.ts')).toBe('/tmp/a.ts')
  })

  it('quotes an empty argument', () => {
    expect(quoteExecArg('')).toBe("''")
  })
})
