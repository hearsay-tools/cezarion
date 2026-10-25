import { type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
// fixture-server starts: 1
// hearsay-tools/cezarion#1699: completed local reproduction at proof_base
// 5136044253bd4046f2cdb72a2222a7181b77b248 in a disposable worktree with its own dependencies.
// Command: pnpm exec vitest run --project e2e packages/web/e2e/fixture-home-isolation.e2e.ts
// Old helper: 1 failed (host-agents-sentinel reached the catalog); fixed helper: 1 passed
// (both host sentinels absent, project sentinel retained), with VITEST deleted in both runs.
// This API-only test attaches no browser, so it produces no browser failure bundle.

it('excludes invoking HOME skills from a real fixture server while keeping project skills', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-e2e-home-isolation-'))
  const invokingHome = join(root, 'invoking-home'), repo = join(root, 'repo')
  let server: ChildProcess | undefined
  const previousHome = process.env.HOME
  try {
    for (const [dir, name] of [['.agents/skills', 'host-agents-sentinel'], ['.claude/skills', 'host-claude-sentinel']] as const) {
      const skillDir = join(invokingHome, dir, name)
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), '# Host-only skill\nMust never reach this server.\n')
    }
    mkdirSync(join(repo, '.ai/skills'), { recursive: true })
    writeFileSync(join(repo, '.ai/skills/project-sentinel.md'), '# Project skill\nMust remain discoverable.\n')
    // Simulate the invoking account, then restore it before any browser or tool runs.
    process.env.HOME = invokingHome
    const env = fixtureServeEnv(repo, { USERPROFILE: invokingHome })
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    delete env.VITEST // Exercise production discovery, including the global directory walk.
    server = spawnFixtureServer([cezarCli, 'serve', '--repo', repo, '--port', '0', '--no-open'], { env })
    const origin = await waitForFixtureServer(server)
    const project = await bootProjectId(origin)
    const response = await fetch(`${origin}/api/v1/p/${project}/skills`)
    expect(response.ok).toBe(true)
    const skills = await response.json() as Array<{ name: string }>
    const names = skills.map(skill => skill.name)
    expect(names).toContain('project-sentinel')
    expect(names).not.toContain('host-agents-sentinel')
    expect(names).not.toContain('host-claude-sentinel')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await stopFixtureServer(server)
    rmSync(root, { recursive: true, force: true })
  }
})
