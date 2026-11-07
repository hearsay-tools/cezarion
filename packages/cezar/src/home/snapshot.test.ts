import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from './home.ts';
import { prepareHome } from './entry.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';

afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });

it.each(['dangling .bak', 'blocked .bak journal HEAD', 'unmarked dangling .bak', 'unmarked blocked .bak journal HEAD'])('keeps primary saves working with a %s', async fault => {
  const home = Home.sandbox(storeRoot());
  await mergeWriteWorkspaceConfig(value => { value.saved = 'old'; }, home);
  const backup = `${home.workspaceConfig}.bak`;
  if (fault.includes('dangling .bak')) {
    rmSync(backup);
    symlinkSync(join(home.root, 'missing'), backup);
  } else {
    const directory = join(home.root, '.versions', 'config.json.bak');
    rmSync(directory, { recursive: true });
    writeFileSync(directory, 'blocks HEAD');
  }
  if (fault.startsWith('unmarked')) {
    rmSync(join(home.root, 'install.json'));
    prepareHome(home, 'projects');
    expect(JSON.parse(readFileSync(join(home.root, 'install.json'), 'utf8')).kind).toBe('test');
  }
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await mergeWriteWorkspaceConfig(value => { value.saved = 'first'; }, home);
  await mergeWriteWorkspaceConfig(value => { value.saved = 'next'; }, home);
  expect(JSON.parse(readFileSync(home.workspaceConfig, 'utf8')).saved).toBe('next');
  expect(warning).toHaveBeenCalledTimes(1);
});

it('keeps the primary committed when the .bak journal fails after its preflight', async () => {
  const home = Home.sandbox(storeRoot());
  await mergeWriteWorkspaceConfig(value => { value.saved = 'old'; }, home);
  await mergeWriteWorkspaceConfig(value => {
    value.saved = 'new';
    // The primary transaction owns its lock; model a newly blocked auxiliary journal.
    const head = join(home.root, '.versions', 'config.json.bak', 'HEAD');
    rmSync(head);
    mkdirSync(head);
  }, home);
  expect(JSON.parse(readFileSync(home.workspaceConfig, 'utf8')).saved).toBe('new');
});
