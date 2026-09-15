// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { runnerSchema, type AgentConfigFile } from '@open-mercato/cezar-api-client'
import { AGENT_DESCRIPTORS, descriptorFor } from './agent-descriptors'

/** The descriptor table driving Settings → Agent config (spec 2026-07-17-agent-config-by-agent). */

function fileOf(over: Partial<AgentConfigFile> & Pick<AgentConfigFile, 'id'>): AgentConfigFile {
  return {
    label: over.id,
    runners: ['claude'],
    kind: 'settings',
    scope: 'project',
    format: 'json',
    tracked: 'tracked',
    seeded: false,
    holdsMcp: false,
    precedence: 'p',
    docsUrl: 'https://example.com',
    path: `/repo/${over.id}`,
    exists: true,
    size: 1,
    version: 'v1',
    writable: true,
    ...over,
  }
}

describe('AGENT_DESCRIPTORS', () => {
  // The guard #322 asked for: a runner shipped without a Settings → Agent config pane fails here,
  // the way a runner without a catalog adapter fails #321's. `runnerSchema` is the contract's
  // mirror of `RUNNER_IDS`, which the web package cannot import directly.
  it('has exactly one entry per runner id, in runner order — a new runner must ship a descriptor', () => {
    expect(AGENT_DESCRIPTORS.map((d) => d.id)).toEqual([...runnerSchema.options])
  })

  it('gives every agent settings/mcp/memory groups in stable order, each MCP group saying where servers live', () => {
    for (const d of AGENT_DESCRIPTORS) {
      expect(d.groups.map((g) => g.id)).toEqual(['settings', 'mcp', 'memory'])
      expect(d.groups.find((g) => g.id === 'mcp')?.note).toBeTruthy()
    }
  })

  it('Pi’s MCP group explains its emptiness — no file exists to list, and the note says what to try', () => {
    const mcp = descriptorFor('pi').groups.find((g) => g.id === 'mcp')!
    expect(mcp.empty).toMatch(/No MCP/)
    expect(mcp.empty).toMatch(/extension/i)
    // the other groups have files to list, so they carry no empty-state copy
    expect(descriptorFor('pi').groups.find((g) => g.id === 'settings')!.empty).toBeUndefined()
  })

  it('a Pi-owned file lands in Pi’s pane and nowhere else', () => {
    const piSettings = fileOf({ id: 'pi.project.settings', runners: ['pi'], kind: 'settings' })
    expect(descriptorFor('pi').groups.find((g) => g.id === 'settings')!.files(piSettings)).toBe(true)
    expect(descriptorFor('pi').groups.find((g) => g.id === 'mcp')!.files(piSettings)).toBe(false)
    expect(descriptorFor('claude').groups.find((g) => g.id === 'settings')!.files(piSettings)).toBe(false)
  })

  it('membership uses runners[] inclusion — shared files belong to every reader', () => {
    const shared = fileOf({ id: 'project.agents', runners: ['codex', 'opencode', 'pi'], kind: 'memory', format: 'markdown' })
    expect(descriptorFor('codex').groups.find((g) => g.id === 'memory')!.files(shared)).toBe(true)
    expect(descriptorFor('opencode').groups.find((g) => g.id === 'memory')!.files(shared)).toBe(true)
    expect(descriptorFor('pi').groups.find((g) => g.id === 'memory')!.files(shared)).toBe(true)
    expect(descriptorFor('claude').groups.find((g) => g.id === 'memory')!.files(shared)).toBe(false)
  })

  it('holdsMcp promotes a file into the MCP group without leaving its own kind', () => {
    const codexConfig = fileOf({ id: 'codex.project.config', runners: ['codex'], kind: 'settings', holdsMcp: true })
    const codex = descriptorFor('codex')
    expect(codex.groups.find((g) => g.id === 'settings')!.files(codexConfig)).toBe(true)
    expect(codex.groups.find((g) => g.id === 'mcp')!.files(codexConfig)).toBe(true)
    expect(codex.groups.find((g) => g.id === 'memory')!.files(codexConfig)).toBe(false)
  })

  it('a dedicated mcp-kind file lands in the MCP group only', () => {
    const mcpJson = fileOf({ id: 'claude.project.mcp', kind: 'mcp', holdsMcp: true })
    const claude = descriptorFor('claude')
    expect(claude.groups.find((g) => g.id === 'mcp')!.files(mcpJson)).toBe(true)
    expect(claude.groups.find((g) => g.id === 'settings')!.files(mcpJson)).toBe(false)
  })

  it('descriptorFor throws on an unknown agent id', () => {
    expect(() => descriptorFor('nope' as never)).toThrow(/no agent descriptor/)
  })
})
