import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { releaseFixtureLease } from './fixture-lease-release.testkit.ts';

it('releases only its lease after a transient independent lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-fixture-lease-'));
  const path = join(root, 'lease.sqlite');
  const db = new DatabaseSync(path);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    db.exec('CREATE TABLE holders (id TEXT PRIMARY KEY, token TEXT NOT NULL)');
    db.exec("INSERT INTO holders VALUES ('live','own'),('other','foreign')");
    child = spawn(process.execPath, ['--input-type=module', '-e', "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); console.log('locked'); setTimeout(()=>{db.exec('ROLLBACK'); db.close()},400)", path], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit'); await once(child.stdout!, 'data');
    releaseFixtureLease(db, 'live', 'own');
    await exited;
    expect(db.prepare('SELECT id FROM holders').all()).toEqual([{ id: 'other' }]);
  } finally { db.close(); if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } await rm(root, { recursive: true, force: true }); }
});

it('fails on a sustained lock and preserves both leases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-fixture-lease-'));
  const path = join(root, 'lease.sqlite'); const db = new DatabaseSync(path);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    db.exec('CREATE TABLE holders (id TEXT PRIMARY KEY, token TEXT NOT NULL)');
    db.exec("INSERT INTO holders VALUES ('live','own'),('other','foreign')");
    child = spawn(process.execPath, ['--input-type=module', '-e', "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); console.log('locked'); process.stdin.once('data',()=>{db.exec('ROLLBACK'); db.close()})", path], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'exit'); await once(child.stdout!, 'data');
    expect(() => releaseFixtureLease(db, 'live', 'own')).toThrow(/locked/);
    child.stdin!.end('release'); await exited;
    expect(db.prepare('SELECT id FROM holders ORDER BY id').all()).toEqual([{ id: 'live' }, { id: 'other' }]);
    expect(() => releaseFixtureLease(db, 'live', 'changed')).toThrow('Fixture lease ownership changed');
    expect(db.prepare('SELECT id FROM holders ORDER BY id').all()).toEqual([{ id: 'live' }, { id: 'other' }]);
  } finally { db.close(); if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } await rm(root, { recursive: true, force: true }); }
});
