import { describe, expect, it } from 'vitest'

import {
  WORKTREE_SETUP_MAX_COMMAND_LENGTH,
  WORKTREE_SETUP_MAX_COMMANDS,
  WORKTREE_SETUP_MAX_TIMEOUT_SECONDS,
} from '@open-mercato/cezar-api-client/contract/workspace'
import { parseWorktreeSetupInput } from './worktree-setup-input'

describe('parseWorktreeSetupInput', () => {
  it('trims commands, drops blank lines, and parses the timeout', () => {
    expect(parseWorktreeSetupInput('  npm ci  \n\n cp a b\r\n ', ' 60 ')).toEqual({
      commands: ['npm ci', 'cp a b'], timeoutSeconds: 60, invalid: null,
    })
    expect(parseWorktreeSetupInput(' \n', '900')).toEqual({
      commands: [], timeoutSeconds: 900, invalid: null,
    })
  })

  it('accepts the command count and length limits', () => {
    const commands = Array(WORKTREE_SETUP_MAX_COMMANDS).fill('echo ok').join('\n')
    expect(parseWorktreeSetupInput(commands, '1').invalid).toBeNull()
    expect(parseWorktreeSetupInput('x'.repeat(WORKTREE_SETUP_MAX_COMMAND_LENGTH), '900').invalid).toBeNull()
  })

  it('reports command count before command length and timeout errors', () => {
    const commands = Array(WORKTREE_SETUP_MAX_COMMANDS + 1)
      .fill('x'.repeat(WORKTREE_SETUP_MAX_COMMAND_LENGTH + 1)).join('\n')
    expect(parseWorktreeSetupInput(commands, '').invalid).toBe(`Enter at most ${WORKTREE_SETUP_MAX_COMMANDS} commands.`)
  })

  it('reports command length before timeout errors', () => {
    expect(parseWorktreeSetupInput('x'.repeat(WORKTREE_SETUP_MAX_COMMAND_LENGTH + 1), '').invalid)
      .toBe(`Keep each command under ${WORKTREE_SETUP_MAX_COMMAND_LENGTH.toLocaleString('en-US')} characters.`)
  })

  it.each(['', ' ', 'NaN', 'Infinity', '0', '-1', '1.5', String(WORKTREE_SETUP_MAX_TIMEOUT_SECONDS + 1)])(
    'rejects invalid timeout %j even with no commands', (timeoutText) => {
      expect(parseWorktreeSetupInput('', timeoutText).invalid)
        .toBe(`Enter a whole number of seconds from 1 to ${WORKTREE_SETUP_MAX_TIMEOUT_SECONDS}.`)
    },
  )

  it.each(['1', String(WORKTREE_SETUP_MAX_TIMEOUT_SECONDS), '9e2', '0x10'])(
    'keeps Number conversion for valid timeout %j', (timeoutText) => {
      expect(parseWorktreeSetupInput('npm ci', timeoutText)).toEqual({
        commands: ['npm ci'], timeoutSeconds: Number(timeoutText), invalid: null,
      })
    },
  )
})
