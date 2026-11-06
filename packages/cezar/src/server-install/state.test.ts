import { testHome } from '../home/test-home.testkit.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serverStatePath } from '../paths.ts';
import {
  acquireLock,
  deleteServerState,
  firstIncompleteStep,
  isResolved,
  listServerInstances,
  loadServerState,
  LockHeldError,
  nextFreeInstancePort,
  saveServerState,
} from './state.ts';
import { freshServerState } from './types.ts';
import { z } from 'zod';
import { STEP_STATUSES } from './types.ts';

const STEP_STATUS = z.enum(STEP_STATUSES).enum;


const UNKNOWN_FUTURE_INSTALLER_STATUS = 'running';

describe('server state', () => {
  let home: string;
  const original = process.env.CEZ_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-state-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('degrades to fresh when the file is missing', () => {
    expect(loadServerState(undefined, testHome())).toEqual(freshServerState());
  });

  it('degrades to fresh on corrupt JSON', () => {
    writeFileSync(serverStatePath(undefined, testHome()), 'not json{{{');
    expect(loadServerState(undefined, testHome()).installed).toBe(false);
  });

  it('round-trips and writes 0600', () => {
    const s = freshServerState();
    s.platform = 'ubuntu-vps';
    s.steps.deps = { status: STEP_STATUS.done, created: null };
    saveServerState(s, undefined, testHome());
    const mode = statSync(serverStatePath(undefined, testHome())).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(loadServerState(undefined, testHome()).steps.deps?.status).toBe('done');
  });

  it('firstIncompleteStep skips done and skipped, stops at pending/failed', () => {
    const s = freshServerState();
    s.steps = {
      a: { status: STEP_STATUS.done, created: null },
      b: { status: STEP_STATUS.skipped, created: null },
      c: { status: STEP_STATUS.failed, created: null },
    };
    expect(firstIncompleteStep(['a', 'b', 'c', 'd'], s)).toBe('c');
    expect(isResolved(s.steps.a)).toBe(true);
    expect(isResolved(s.steps.b)).toBe(true);
    expect(isResolved(s.steps.c)).toBe(false);
  });

  it('lock is exclusive against a live foreign pid and reclaims stale', () => {
    const release = acquireLock(undefined, testHome());
    // simulate a live foreign holder
    writeFileSync(join(home, 'server.install.lock'), `${process.pid === 1 ? 2 : 1}\n`);
    // pid 1 is alive on posix; expect the lock to be held
    expect(() => acquireLock(undefined, testHome())).toThrow(LockHeldError);
    // a dead pid is reclaimed
    writeFileSync(join(home, 'server.install.lock'), '999999999\n');
    const release2 = acquireLock(undefined, testHome());
    release2();
    release();
  });

  it('lock acquisition is atomic (wx) — a pre-existing live lock file always wins', () => {
    // Simulate the race loser: the file appears (live pid) before our write.
    writeFileSync(join(home, 'server.install.lock'), `${process.pid === 1 ? 2 : 1}\n`, { flag: 'wx' });
    expect(() => acquireLock(undefined, testHome())).toThrow(LockHeldError);
  });

  it('named instances persist to their own file and never clobber the default', () => {
    const def = freshServerState();
    def.platform = 'ubuntu-vps';
    def.primaryPort = 4321;
    saveServerState(def, undefined, testHome()); // default → server.json

    const shop = freshServerState();
    shop.platform = 'ubuntu-vps';
    shop.instance = 'shop-example-com';
    shop.domain = 'shop.example.com';
    shop.primaryPort = 4322;
    saveServerState(shop, 'shop-example-com', testHome()); // named → server-instances/…

    // Each loads back independently — the second install did not touch the first.
    expect(loadServerState(undefined, testHome()).primaryPort).toBe(4321);
    expect(loadServerState('shop-example-com', testHome()).primaryPort).toBe(4322);
    expect(loadServerState('shop-example-com', testHome()).domain).toBe('shop.example.com');
    // A brand-new (unknown) instance still degrades to a fresh record.
    expect(loadServerState('nope', testHome()).installed).toBe(false);
  });

  it('listServerInstances enumerates default + named; nextFreeInstancePort skips used ports', () => {
    expect(listServerInstances(testHome())).toHaveLength(0);
    expect(nextFreeInstancePort(undefined, testHome())).toBe(4321); // nothing recorded yet

    const def = freshServerState();
    def.primaryPort = 4321;
    saveServerState(def, undefined, testHome());
    const a = freshServerState();
    a.primaryPort = 4322;
    saveServerState(a, 'a-example-com', testHome());

    const names = listServerInstances(testHome()).map((i) => i.instance).sort();
    expect(names).toEqual(['a-example-com', 'default']);
    expect(nextFreeInstancePort(undefined, testHome())).toBe(4323); // 4321 + 4322 both taken
  });

  it('deleteServerState drops a named record but leaves the default in place', () => {
    saveServerState(freshServerState(), undefined, testHome()); // default
    const a = freshServerState();
    a.primaryPort = 4322;
    saveServerState(a, 'a-example-com', testHome());
    deleteServerState('a-example-com', testHome());
    expect(listServerInstances(testHome()).map((i) => i.instance)).toEqual(['default']);
    // deleting the default is a no-op (legacy single-host record is kept)
    deleteServerState('default', testHome());
    expect(listServerInstances(testHome()).map((i) => i.instance)).toEqual(['default']);
  });

  it('the install lock is per-instance — one instance never blocks another', () => {
    const release = acquireLock('shop-example-com', testHome());
    // a DIFFERENT instance acquires freely (independent lock file)
    const releaseOther = acquireLock('blog-example-com', testHome());
    releaseOther();
    // but the SAME instance is exclusive against a live foreign pid
    writeFileSync(
      join(home, 'server-instances', 'shop-example-com.install.lock'),
      `${process.pid === 1 ? 2 : 1}\n`,
    );
    expect(() => acquireLock('shop-example-com', testHome())).toThrow(LockHeldError);
    release();
  });

  it('a newer-version server.json degrades per-field, never to a fresh record', () => {
    writeFileSync(
      serverStatePath(undefined, testHome()),
      JSON.stringify({
        schema: 1,
        platform: 'ubuntu-vps-caddy', // platform this version does not ship
        installed: true,
        primaryPort: 4321,
        futureField: { keep: 'me' },
        steps: {
          deps: { status: STEP_STATUS.done, created: { artifacts: [] } },
          'future-step': { status: UNKNOWN_FUTURE_INSTALLER_STATUS, created: null }, // unknown status
        },
      }),
    );
    const s = loadServerState(undefined, testHome());
    expect(s.platform).toBe('ubuntu-vps-caddy'); // ledger intact
    expect(s.installed).toBe(true);
    expect(s.steps.deps?.status).toBe('done');
    // unknown status degrades to failed (stays on the undo path), not to data loss
    expect(s.steps['future-step']?.status).toBe('failed');
    // unknown top-level fields survive a load+save round-trip
    saveServerState(s, undefined, testHome());
    expect(JSON.parse(readFileSync(serverStatePath(undefined, testHome()), 'utf8')).futureField).toEqual({ keep: 'me' });
  });
});
