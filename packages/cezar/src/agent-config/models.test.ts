import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readAgentModelDefaults, readAgentModelProvider } from './models.ts';

describe('readAgentModelDefaults', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('reads each agent format and honours project/local precedence', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cez-native-models-repo-'));
    const home = mkdtempSync(join(tmpdir(), 'cez-native-models-home-'));
    roots.push(repo, home);
    mkdirSync(join(repo, '.claude'), { recursive: true });
    mkdirSync(join(repo, '.codex'), { recursive: true });
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });

    writeFileSync(join(home, '.claude', 'settings.json'), '{"model":"user-claude"}\n');
    writeFileSync(join(repo, '.claude', 'settings.json'), '{"model":"project-claude"}\n');
    writeFileSync(join(repo, '.claude', 'settings.local.json'), '{"model":"local-claude"}\n');
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "user-codex"\n');
    writeFileSync(join(repo, '.codex', 'config.toml'), 'model = "project-codex"\n');
    writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), '{"model":"openai/user"}\n');
    writeFileSync(join(repo, 'opencode.json'), '{\n  // project wins\n  "model": "openai/project",\n}\n');

    await expect(readAgentModelDefaults(repo, { HOME: home })).resolves.toEqual({
      claude: 'local-claude',
      codex: 'project-codex',
      opencode: 'openai/project',
    });
  });

  it('falls back when a higher-precedence file is missing or malformed', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cez-native-models-repo-'));
    const home = mkdtempSync(join(tmpdir(), 'cez-native-models-home-'));
    roots.push(repo, home);
    mkdirSync(join(repo, '.claude'), { recursive: true });
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'settings.json'), '{not json');
    writeFileSync(join(home, '.claude', 'settings.json'), '{"model":"user-claude"}');

    await expect(readAgentModelDefaults(repo, { HOME: home })).resolves.toEqual({ claude: 'user-claude' });
  });

  it('reads Claude custom models from settings env and host ANTHROPIC_MODEL', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cez-native-models-repo-'));
    const home = mkdtempSync(join(tmpdir(), 'cez-native-models-home-'));
    roots.push(repo, home);
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_MODEL: 'deepseek/deepseek-v4-flash' } }),
    );

    await expect(readAgentModelDefaults(repo, { HOME: home })).resolves.toEqual({
      claude: 'deepseek/deepseek-v4-flash',
    });
    await expect(
      readAgentModelDefaults(repo, { HOME: home, ANTHROPIC_MODEL: 'deepseek' }),
    ).resolves.toEqual({ claude: 'deepseek' });
  });

  it('pairs a Codex custom provider with its configured model', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cez-native-models-repo-'));
    const home = mkdtempSync(join(tmpdir(), 'cez-native-models-home-'));
    roots.push(repo, home);
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      join(home, '.codex', 'config.toml'),
      'model = "deepseek-chat"\nmodel_provider = "deepseek"\n',
    );

    await expect(readAgentModelDefaults(repo, { HOME: home })).resolves.toEqual({
      codex: 'deepseek/deepseek-chat',
    });
    await expect(readAgentModelProvider('codex', repo, { HOME: home })).resolves.toBe('deepseek');
  });

  it('reads the effective Codex provider even when no native model is pinned', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cez-native-models-repo-'));
    const home = mkdtempSync(join(tmpdir(), 'cez-native-models-home-'));
    roots.push(repo, home);
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), 'model_provider = "deepseek"\n');

    await expect(readAgentModelDefaults(repo, { HOME: home })).resolves.toEqual({});
    await expect(readAgentModelProvider('codex', repo, { HOME: home })).resolves.toBe('deepseek');
  });
  it('composes Pi’s startup model as provider/model from settings.json', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cez-native-models-repo-'));
    const home = mkdtempSync(join(tmpdir(), 'cez-native-models-home-'));
    roots.push(repo, home);
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-5' }),
    );

    await expect(readAgentModelDefaults(repo, { HOME: home })).resolves.toEqual({ pi: 'anthropic/claude-sonnet-5' });
    await expect(readAgentModelProvider('pi', repo, { HOME: home })).resolves.toBe('anthropic');
  });

  it('lets Pi’s project settings override the global ones and honours PI_CODING_AGENT_DIR', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cez-native-models-repo-'));
    const home = mkdtempSync(join(tmpdir(), 'cez-native-models-home-'));
    roots.push(repo, home);
    mkdirSync(join(home, 'pi-dir'), { recursive: true });
    mkdirSync(join(repo, '.pi'), { recursive: true });
    writeFileSync(
      join(home, 'pi-dir', 'settings.json'),
      JSON.stringify({ defaultProvider: 'openai', defaultModel: 'gpt-5', defaultProjectTrust: 'always' }),
    );
    writeFileSync(join(repo, '.pi', 'settings.json'), JSON.stringify({ defaultModel: 'gpt-5-mini' }));

    await expect(
      readAgentModelDefaults(repo, { HOME: home, PI_CODING_AGENT_DIR: join(home, 'pi-dir') }),
    ).resolves.toEqual({ pi: 'openai/gpt-5-mini' });
  });

  // cezar runs Pi in `--mode rpc`, which never prompts for project trust: without a saved
  // decision Pi falls back to the global `defaultProjectTrust`, and `ask` (the default) or
  // `never` ignore `.pi/settings.json` outright. Reading a model from a file Pi would ignore, then
  // passing it as `--model`, would force a model Pi itself would not choose.
  it('ignores Pi’s project settings for the native default unless the global defaultProjectTrust is "always"', async () => {
    for (const trust of [undefined, 'ask', 'never']) {
      const repo = mkdtempSync(join(tmpdir(), 'cez-native-models-repo-'));
      const home = mkdtempSync(join(tmpdir(), 'cez-native-models-home-'));
      roots.push(repo, home);
      mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
      mkdirSync(join(repo, '.pi'), { recursive: true });
      writeFileSync(
        join(home, '.pi', 'agent', 'settings.json'),
        JSON.stringify({ defaultProvider: 'openai', defaultModel: 'gpt-5', ...(trust ? { defaultProjectTrust: trust } : {}) }),
      );
      writeFileSync(join(repo, '.pi', 'settings.json'), JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-5' }));

      await expect(readAgentModelDefaults(repo, { HOME: home }), `defaultProjectTrust=${trust}`).resolves.toEqual({ pi: 'openai/gpt-5' });
      await expect(readAgentModelProvider('pi', repo, { HOME: home }), `defaultProjectTrust=${trust}`).resolves.toBe('openai');
    }
  });

  it('reports no Pi default from a project file alone — no global file means no trust decision', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cez-native-models-repo-'));
    const home = mkdtempSync(join(tmpdir(), 'cez-native-models-home-'));
    roots.push(repo, home);
    mkdirSync(join(repo, '.pi'), { recursive: true });
    writeFileSync(join(repo, '.pi', 'settings.json'), JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-5' }));

    await expect(readAgentModelDefaults(repo, { HOME: home })).resolves.toEqual({});
  });

  it('reports no Pi default when settings.json is absent', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cez-native-models-repo-'));
    const home = mkdtempSync(join(tmpdir(), 'cez-native-models-home-'));
    roots.push(repo, home);
    await expect(readAgentModelDefaults(repo, { HOME: home })).resolves.toEqual({});
  });
});
