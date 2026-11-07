import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXIT } from '../task-cli/cli.ts';
import { bodyFromAddFlags, parseEvery, runAutomationCommand, type AutomationIo } from './automation-cli.ts';

const env = { CEZ_COCKPIT_URL: 'http://127.0.0.1:4321', CEZ_PROJECT_ID: 'project' };
const definition = { id: 'a1', name: 'Nightly', kind: 'schedule', enabled: false, revision: 1, schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Go' } };

function client(http: NonNullable<AutomationIo['http']>, extra: Partial<AutomationIo> = {}) {
  const output: string[] = [];
  return {
    run: (argv: string[]) => runAutomationCommand(argv, env, { stdout: line => output.push(line), http, ...extra }),
    last: () => JSON.parse(output.at(-1) ?? 'null') as Record<string, unknown>,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('automation CLI input boundaries', () => {
  it.each(['x5m', '5mx'])('rejects a partial duration %s', value => {
    expect(() => parseEvery(value)).toThrow(/--every/);
  });

  it('trims names and duration input', () => {
    expect(parseEvery(' 5m ')).toBe(300);
    expect(bodyFromAddFlags({ name: ' Nightly ', cron: '0 4 * * *', enable: true }, 'Go')).toMatchObject({ name: 'Nightly', enable: true });
  });

  it.each([
    { name: '   ', cron: '0 4 * * *' },
    { name: 'Nightly' },
    { name: 'Nightly', cron: '0 4 * * *', autonomous: true, 'no-autonomous': true },
    { name: 'Nightly', in: '1h', 'include-existing': true },
  ])('refuses invalid add flags %j', flags => {
    expect(() => bodyFromAddFlags(flags, 'Go')).toThrow();
  });

  it('rejects a whitespace-only prompt and label events without changed labels', () => {
    expect(() => bodyFromAddFlags({ name: 'N', cron: '0 4 * * *' }, '  ')).toThrow(/--prompt/);
    expect(() => bodyFromAddFlags({ name: 'N', on: 'issue.labeled' }, 'Go')).toThrow(/--changed-label/);
  });

  it.each(['10m', '30d'])('accepts the latest-start boundary %s', duration => {
    expect(bodyFromAddFlags({ name: 'N', in: '1h', tz: 'UTC', 'latest-start': duration }, 'Go').schedule).toMatchObject({ latestStartMinutes: duration === '10m' ? 10 : 43_200 });
  });

  it.each([
    [[], /missing command/],
    [['unknown'], /unknown command/],
    [['list', 'extra'], /takes no positional arguments/],
    [['create', '--file', 'a.json', '--json', '{}'], /--file OR --json/],
    [['create', '--json', '  '], /no definition given/],
    [['create', '--json', '{'], /not valid JSON/],
    [['create', '--json', 'null'], /must be a JSON object/],
    [['create', '--json', '42'], /must be a JSON object/],
    [['add', '--name', 'N', '--cron', '0 4 * * *', '--prompt', 'Go', '--prompt-file', 'p.md'], /--prompt OR --prompt-file/],
  ] as const)('reports the input error for %j', async (argv, error) => {
    const http = vi.fn<NonNullable<AutomationIo['http']>>();
    const cli = client(http);
    expect(await cli.run([...argv])).toBe(EXIT.usage);
    expect(cli.last()).toMatchObject({ code: 'invalid_input', error: expect.stringMatching(error) });
    expect(http).not.toHaveBeenCalled();
  });

  it('reports an absent stdin provider as missing input', async () => {
    const cli = client(async () => ({ status: 200, data: {} }));
    expect(await cli.run(['create'])).toBe(EXIT.usage);
    expect(cli.last().error).toMatch(/no definition given/);
  });

  it('reads a definition and prompt from real UTF-8 files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'automation-cli-'));
    const bodies: unknown[] = [];
    const cli = client(async (_url, init) => {
      bodies.push(init?.body);
      return { status: 201, data: { automation: definition } };
    });
    try {
      await writeFile(join(dir, 'definition.json'), JSON.stringify({ name: 'N', task: { prompt: 'Żółw' } }));
      await writeFile(join(dir, 'prompt.md'), 'Żółw');
      expect(await cli.run(['create', '--file', join(dir, 'definition.json')])).toBe(EXIT.ok);
      expect(await cli.run(['add', '--name', 'N', '--cron', '0 4 * * *', '--prompt-file', join(dir, 'prompt.md')])).toBe(EXIT.ok);
      expect(bodies).toEqual([
        { name: 'N', task: { prompt: 'Żółw' }, intervalSeconds: 300, filters: {} },
        { name: 'N', kind: 'schedule', schedule: definition.schedule, task: { prompt: 'Żółw', worktree: true, autonomous: true } },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([new Error('read denied'), 'read denied'])('reports a failed file read: %s', async error => {
    const cli = client(async () => ({ status: 200, data: {} }), { readFile: async () => { throw error; } });
    expect(await cli.run(['create', '--file', 'missing.json'])).toBe(EXIT.usage);
    expect(cli.last().error).toBe('cannot read missing.json: read denied');
  });

  it.each([new Error('transport broke'), 'transport broke'])('reports an unexpected transport failure: %s', async error => {
    const cli = client(async () => { throw error; });
    expect(await cli.run(['list'])).toBe(EXIT.refused);
    expect(cli.last()).toEqual({ code: 'internal', error: 'transport broke' });
  });

  it.each(['help', '-h'])('prints help with the default output for %s', async flag => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runAutomationCommand([flag], {})).toBe(EXIT.ok);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cez automation'));
  });

  it.each([false, true])('reads default stdin with isTTY=%s', async isTTY => {
    const stdin = Object.assign(Readable.from(['{"name":', Buffer.from('"N","task":{"prompt":"Go"}}')]), { isTTY });
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as typeof process.stdin);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ automation: definition }), { status: 201, headers: { 'content-type': 'application/json' } }));
    expect(await runAutomationCommand(['create'], env)).toBe(isTTY ? EXIT.usage : EXIT.ok);
    if (isTTY) {
      expect(fetch).not.toHaveBeenCalled();
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ code: 'invalid_input', error: expect.stringMatching(/no definition given/) });
    } else {
      expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ name: 'N', task: { prompt: 'Go' } });
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ id: 'a1', schedule: 'every day at 04:00' });
    }
  });
});
