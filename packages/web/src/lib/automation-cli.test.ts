// @vitest-environment node

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { CreateAutomationInput } from '@open-mercato/cezar-api-client'

// Test-only reach into the service: the round trip must run the CLI's own parser and body
// builder, not a copy of them (AGENTS.md: cross-package test reaches are ugly on purpose).
import { runAutomationCommand } from '../../../cezar/src/automations/automation-cli.ts'
import { fromDefinition, toCreateBody, type AutomationDraft } from '../routes/automations/editor-draft'
import { cliOf, flagExpressible, shellQuote } from './automation-cli'

const HOSTILE = "Don't stop!\nRun `whoami` and $(id) then echo \"$HOME\" \\ done"

function scheduleDraft(overrides: Partial<AutomationDraft> = {}): AutomationDraft {
  return {
    ...fromDefinition({
      name: 'Morning triage',
      kind: 'schedule',
      schedule: { type: 'weekdays', hour: 7, minute: 0 },
      task: { prompt: 'Triage new issues', workflow: 'quick-task', worktree: true, autonomous: true },
    }),
    ...overrides,
  }
}

function pollDraft(overrides: Partial<AutomationDraft> = {}): AutomationDraft {
  return {
    ...fromDefinition({
      name: 'Review PRs',
      kind: 'github',
      events: ['pull_request.opened', 'issue.opened'],
      intervalSeconds: 3_600,
      filters: { anyLabels: ['needs review'], authors: ['octo cat'], lookbackDays: 7, maxRecords: 25 },
      task: { prompt: 'Review the diff', worktree: true, autonomous: true },
    }),
    ...overrides,
  }
}

function completionDraft(draft: AutomationDraft, completion: Partial<Pick<CreateAutomationInput['task'], 'archiveWhenDone' | 'autoMergePr'>>): AutomationDraft {
  const body = toCreateBody(draft)
  return fromDefinition({ ...body, task: { ...body.task, ...completion } })
}

describe('shellQuote', () => {
  it('single-quotes for a POSIX shell, closing and escaping embedded quotes', () => {
    expect(shellQuote('plain')).toBe("'plain'")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote('')).toBe("''")
  })
})

describe('cliOf', () => {
  it('prints a schedule as the add flag form', () => {
    expect(cliOf(scheduleDraft())).toBe(
      "cez automation add --name 'Morning triage' --cron '0 7 * * 1-5' --workflow 'quick-task' --prompt 'Triage new issues'",
    )
  })

  it('says --no-autonomous and --enable when the draft does', () => {
    const line = cliOf(scheduleDraft({ autonomous: false, enabled: true, runner: 'codex', model: 'gpt-5' }))
    expect(line).toContain(" --runner 'codex' --model 'gpt-5' --no-autonomous --enable --prompt ")
  })

  it('prints enabled completion controls as flags', () => {
    const draft = completionDraft(scheduleDraft(), { archiveWhenDone: true, autoMergePr: true })
    expect(flagExpressible(draft)).toBe(true)
    expect(cliOf(draft)).toContain(' --archive-when-done --auto-merge-pr ')
    expect(cliOf(scheduleDraft())).not.toMatch(/--archive-when-done|--auto-merge-pr/)
  })

  it('prints a poll with any-of labels and authors as flags', () => {
    expect(cliOf(pollDraft())).toBe(
      "cez automation add --name 'Review PRs' --on 'pull_request.opened,issue.opened' --every 1h --label 'needs review' --author 'octo cat' --prompt 'Review the diff'",
    )
  })

  it('copies an existing-items choice as a flag', () => {
    const draft = pollDraft({ filters: { includeExisting: true, lookbackDays: 7, maxRecords: 25 } })
    expect(cliOf(draft)).toContain(' --include-existing ')
    expect(cliOf(draft)).toMatch(/^cez automation add /)
  })

  it('falls back to create --json for what flags cannot say', () => {
    const cases: AutomationDraft[] = [
      pollDraft({ filters: { excludeLabels: ['wontfix'], lookbackDays: 7, maxRecords: 25 } }),
      pollDraft({ filters: { lookbackDays: 14, maxRecords: 25 } }),
      scheduleDraft({ description: 'Weekday mornings' }),
      // A definition made in the cockpit carries no `worktree`; `add` always sends `worktree: true`.
      scheduleDraft({ taskExtra: {} }),
      scheduleDraft({ taskExtra: { worktree: true, effort: 'high' } }),
      scheduleDraft({ workflow: undefined, taskExtra: { worktree: true, steps: [{ id: 'task', prompt: '{{task}}' }] } }),
    ]
    for (const draft of cases) {
      expect(flagExpressible(draft)).toBe(false)
      expect(cliOf(draft)).toMatch(/^cez automation create --json '/)
    }
  })
})

describe('Copy as CLI round-trips through a real shell into the cez automation request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-copy-as-cli-'))
  const stub = join(dir, 'argv.mjs')
  writeFileSync(stub, 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), env: { CEZ_COCKPIT_URL: process.env.CEZ_COCKPIT_URL, CEZ_PROJECT_ID: process.env.CEZ_PROJECT_ID } }))\n')
  const ADDRESS = { origin: 'http://127.0.0.1:4391', projectId: "it's-a-project" }
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  /**
   * The copied line, run by `sh` with `cez automation` swapped for a stub that echoes argv and the
   * address it received — from an ORDINARY shell: no CEZ_* in the environment, as a user pastes it.
   */
  function shellRun(line: string): { argv: string[]; env: NodeJS.ProcessEnv } {
    const at = line.indexOf('cez automation ')
    expect(at).toBeGreaterThan(0)
    const command = `${line.slice(0, at)}${shellQuote(process.execPath)} ${shellQuote(stub)} ${line.slice(at + 'cez automation '.length)}`
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CEZ_')))
    return JSON.parse(execFileSync('sh', ['-c', command], { encoding: 'utf8', env })) as { argv: string[]; env: NodeJS.ProcessEnv }
  }

  /** What `cez automation` would POST for that argv and env — its own parser, body builder and transport seam. */
  async function posted(argv: string[], env: NodeJS.ProcessEnv): Promise<{ url: string; body: Record<string, unknown> }> {
    let body: Record<string, unknown> | undefined
    let url = ''
    const out: string[] = []
    const code = await runAutomationCommand(argv, env, {
      stdout: (line) => out.push(line),
      http: async (target, init) => {
        url = target
        body = init?.body as Record<string, unknown>
        return { status: 201, data: { automation: { id: 'a1', name: 'x', enabled: false, revision: 1 } } }
      },
    })
    expect(code, out.join('\n')).toBe(0)
    return { url, body: body! }
  }

  /** `enable: false` and an absent `enable` both create a paused automation. */
  const paused = (body: object) => {
    const { enable, ...rest } = body as { enable?: boolean }
    return enable ? { ...rest, enable } : rest
  }

  const drafts: Array<[string, AutomationDraft, 'add' | 'create']> = [
    ['a schedule with a hostile prompt', scheduleDraft({ prompt: HOSTILE }), 'add'],
    ['a prompt that starts with a dash', scheduleDraft({ prompt: '- bullet one\n- bullet two' }), 'add'],
    ['--no-autonomous, --enable and a quoted name', scheduleDraft({ name: "Bob's  nightly $(id)", autonomous: false, enabled: true, runner: 'codex', model: 'o3' }), 'add'],
    ['a weekly schedule', scheduleDraft({ schedule: { type: 'weekly', hour: 23, minute: 59, day: 7, every: 1 } }), 'add'],
    ['an hourly schedule', scheduleDraft({ schedule: { type: 'hours', hour: 0, minute: 0, day: 1, every: 6 } }), 'add'],
    ['a poll with labels and authors', pollDraft({ prompt: HOSTILE, intervalSeconds: 90 }), 'add'],
    ['a poll including existing matches', pollDraft({ filters: { includeExisting: true, lookbackDays: 7, maxRecords: 25 } }), 'add'],
    ['a poll explicitly excluding existing matches', pollDraft({ filters: { includeExisting: false, lookbackDays: 7, maxRecords: 25 } }), 'create'],
    ['a poll with a label starting with a dash', pollDraft({ filters: { anyLabels: ['-wip'], lookbackDays: 7, maxRecords: 25 } }), 'add'],
    ['a label event with a changed label', pollDraft({ events: ['issue.labeled'], filters: { changedLabels: ['needs-agent'], lookbackDays: 7, maxRecords: 25 } }), 'add'],
    ['a poll with exclusions', pollDraft({ prompt: HOSTILE, filters: { excludeLabels: ["won't fix"], lookbackDays: 3, maxRecords: 10 } }), 'create'],
    ['a schedule that archives completed tasks', completionDraft(scheduleDraft(), { archiveWhenDone: true }), 'add'],
    ['a poll that merges PRs', completionDraft(pollDraft(), { autoMergePr: true }), 'add'],
    ['a schedule with both completion controls', completionDraft(scheduleDraft(), { archiveWhenDone: true, autoMergePr: true }), 'add'],
    ['a cockpit-made schedule with a description', scheduleDraft({ prompt: HOSTILE, description: "It's `daily`", taskExtra: {} }), 'create'],
  ]

  it.each(drafts)('%s', async (_name, draft, form) => {
    const { argv, env } = shellRun(cliOf(draft, ADDRESS))
    expect(argv[0]).toBe(form)
    expect(env).toEqual({ CEZ_COCKPIT_URL: ADDRESS.origin, CEZ_PROJECT_ID: ADDRESS.projectId })
    const request = await posted(argv, env)
    expect(request.url).toBe(`${ADDRESS.origin}/api/v1/p/${encodeURIComponent(ADDRESS.projectId)}/automations`)
    expect(paused(request.body)).toEqual(paused(toCreateBody(draft)))
  })
})
