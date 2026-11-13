import { afterEach, expect, it, vi } from 'vitest';
import { productIdentity } from './identity.ts';
import { printServeBanner, warnServeBind } from '../serve-boot.ts';
import { BUILD_HINT_HTML } from '../server/static-ui.ts';
import { runMessageCommand, runWorkerCommand } from '../delegation/cli.ts';
import { taskHelp } from '../task-cli/cli.ts';
import { detectEnvironment } from '../core/backend-detect.ts';
import { checkoutRoot, discoverCockpit } from '../task-cli/discovery.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('uses the same identity in serve banners, subcommand help and the missing-build title', async () => {
  const name = productIdentity().displayName;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  printServeBanner('1.2.3', '/repo/cezar', null, [], 'http://localhost:4321');
  expect(log.mock.calls[0]).toEqual([`\n  ${name} v1.2.3 — /repo/cezar`]);
  warnServeBind('0.0.0.0', 4321);
  expect(log.mock.calls.at(-1)?.[0]).toContain(`— ${name} has no built-in auth.`);
  expect(/<title>([^<]*)<\/title>/.exec(BUILD_HINT_HTML)?.[1]).toContain(name);
  await runWorkerCommand(['--help'], {});
  expect(log.mock.calls.at(-1)?.[0]).toContain(`${name} worker — manage owned coding workers`);
  await runMessageCommand(['--help'], {});
  expect(log.mock.calls.at(-1)?.[0]).toContain(`${name} message — task conversations`);
  expect(taskHelp()).toContain(`${name} task — start, watch and steer cockpit tasks`);
});

it('uses the preferred dry-run setting name for every agent', async () => {
  vi.stubEnv('HSQ_DRY_RUN', '1');
  vi.stubEnv('CEZ_DRY_RUN', undefined);
  const checks = await detectEnvironment();
  expect(checks.filter(check => !['gh', 'git'].includes(check.name)).map(check => check.version))
    .toEqual(Array(6).fill('mock (HSQ_DRY_RUN=1)'));
});

it('uses the preferred command in the missing cockpit hint', async () => {
  const root = await checkoutRoot('/tmp');
  await expect(discoverCockpit({ repoDir: '/tmp', ports: [] })).rejects.toMatchObject({
    body: { hint: `start the cockpit in ${root} with: hsq` },
  });
});
