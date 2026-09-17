import { describe, expect, it } from 'vitest';
import { CONFIG_FILES, findConfigFile, listConfigFiles, type AgentHomePaths } from './catalog.ts';

const HOME: AgentHomePaths = {
  claude: '/home/u/.claude',
  codex: '/home/u/.codex',
  opencodeConfig: '/home/u/.config/opencode',
  pi: '/home/u/.pi/agent',
  cursor: '/home/u/.cursor',
};

describe('agent-config catalog', () => {
  it('every id is unique and URL-safe', () => {
    const ids = CONFIG_FILES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9.]+$/);
  });

  it('every entry carries a non-empty precedence string and a docs URL', () => {
    for (const f of CONFIG_FILES) {
      expect(f.precedence.trim().length).toBeGreaterThan(0);
      expect(f.docsUrl).toMatch(/^https:\/\//);
    }
  });

  it('<repo>/AGENTS.md is ONE entry read by every runner that loads it (Codex, OpenCode, Pi)', () => {
    const agents = CONFIG_FILES.filter((f) => f.label === 'AGENTS.md' && f.scope === 'project');
    expect(agents).toHaveLength(1);
    expect(agents[0]!.runners).toEqual(['codex', 'opencode', 'pi', 'cursor']);
  });

  it('lists Pi’s documented files: settings at both scopes and the global AGENTS.md — and no MCP file', () => {
    const pi = CONFIG_FILES.filter((f) => f.runners.includes('pi'));
    expect(pi.map((f) => f.id)).toEqual(['pi.user.settings', 'pi.project.settings', 'pi.user.memory', 'project.agents']);
    expect(pi.some((f) => f.holdsMcp || f.kind === 'mcp')).toBe(false);
    expect(findConfigFile('pi.user.settings')!.resolve('/repo', HOME)).toBe('/home/u/.pi/agent/settings.json');
    expect(findConfigFile('pi.project.settings')!.resolve('/repo', HOME)).toBe('/repo/.pi/settings.json');
    expect(findConfigFile('pi.user.memory')!.resolve('/repo', HOME)).toBe('/home/u/.pi/agent/AGENTS.md');
  });

  it('Pi’s settings expose defaultModel + defaultProvider, project over user', () => {
    const user = findConfigFile('pi.user.settings')!;
    const project = findConfigFile('pi.project.settings')!;
    for (const f of [user, project]) {
      expect(f.modelKey).toBe('defaultModel');
      expect(f.modelProviderKey).toBe('defaultProvider');
    }
    expect(project.modelPriority!).toBeGreaterThan(user.modelPriority!);
  });

  it('resolves repo-relative paths under the repo root', () => {
    const proj = findConfigFile('claude.project.settings')!;
    expect(proj.resolve('/repo', HOME)).toBe('/repo/.claude/settings.json');
  });

  it('honours the injected home dirs (so $CODEX_HOME / $XDG_CONFIG_HOME flow through)', () => {
    expect(findConfigFile('codex.user.config')!.resolve('/repo', HOME)).toBe('/home/u/.codex/config.toml');
    expect(findConfigFile('opencode.user.config')!.resolve('/repo', HOME)).toBe(
      '/home/u/.config/opencode/opencode.json',
    );
    expect(findConfigFile('claude.user.settings')!.resolve('/repo', HOME)).toBe('/home/u/.claude/settings.json');
  });

  it('marks only Claude’s gitignored personal layer as seeded', () => {
    const seeded = CONFIG_FILES.filter((f) => f.seeded).map((f) => f.id).sort();
    expect(seeded).toEqual(['claude.local.memory', 'claude.local.settings']);
    for (const f of CONFIG_FILES) {
      if (f.seeded) expect(f.tracked).toBe('gitignored');
    }
  });

  it('every seeded/gitignored file is a repo-relative path (never in $HOME)', () => {
    for (const f of CONFIG_FILES) {
      if (f.tracked === 'gitignored') expect(f.resolve('/repo', HOME).startsWith('/repo/')).toBe(true);
    }
  });

  it('holdsMcp is set exactly where MCP servers actually live', () => {
    const mcp = CONFIG_FILES.filter((f) => f.holdsMcp).map((f) => f.id).sort();
    expect(mcp).toEqual([
      'claude.project.mcp',
      'codex.project.config',
      'codex.user.config',
      'cursor.project.mcp',
      'opencode.project.config',
      'opencode.user.config',
    ]);
  });

  it('listConfigFiles returns the table; findConfigFile is undefined for junk', () => {
    expect(listConfigFiles().length).toBe(CONFIG_FILES.length);
    expect(findConfigFile('../../etc/passwd')).toBeUndefined();
    expect(findConfigFile('nope')).toBeUndefined();
  });
});
