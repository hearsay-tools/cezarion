import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { windowsWriteIdentity } from '../delegation/windows-workspace-identity.ts';
import { readWindowsEvidence, removeWindowsEvidence, windowsEvidencePath, writeWindowsEvidence } from './windows-worker-evidence.ts';

it.runIf(process.platform === 'win32')('validates, migrates, replaces and removes private worker evidence', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cez-evidence-')));
  const id = '0a00ab00-0000-4000-8000-000000000001';
  try {
    await mkdir(join(root, 'runs'));
    const legacy = join(root, 'runs', `${id}.execution.json`);
    windowsWriteIdentity(legacy, 'legacy', false, false);
    expect(readWindowsEvidence(root, id, 'execution', 100)).toBe('legacy');
    writeWindowsEvidence(root, id, 'execution', 'replacement');
    expect(windowsEvidencePath(root, id, 'execution')).not.toBe(legacy);
    expect(readWindowsEvidence(root, id, 'execution', 100)).toBe('replacement');
    windowsWriteIdentity(legacy, 'duplicate', false, false);
    expect(() => readWindowsEvidence(root, id, 'execution', 100)).toThrow();
    await rm(legacy);
    const execution = windowsEvidencePath(root, id, 'execution');
    const hardlink = join(root, 'hardlink.json');
    await link(execution, hardlink);
    expect(() => readWindowsEvidence(root, id, 'execution', 100)).toThrow();
    expect(() => removeWindowsEvidence(root, id, 'execution')).toThrow();
    await rm(hardlink);
    writeWindowsEvidence(root, id, 'processes', 'first');
    writeWindowsEvidence(root, id, 'processes', 'second');
    expect(readWindowsEvidence(root, id, 'processes', 100)).toBe('second');
    const insecureLegacy = join(root, 'runs', `${id}.identity.json`);
    windowsWriteIdentity(insecureLegacy, 'insecure', false, false);
    execFileSync('icacls.exe', [insecureLegacy, '/grant', '*S-1-1-0:F']);
    expect(() => readWindowsEvidence(root, id, 'identity', 100)).toThrow();
    expect(() => writeWindowsEvidence(root, id, 'identity', 'replacement')).toThrow();
    await rm(insecureLegacy);
    writeWindowsEvidence(root, id, 'identity', 'identity', true);
    expect(() => writeWindowsEvidence(root, id, 'identity', 'collision', true)).toThrow();
    const path = windowsEvidencePath(root, id, 'identity');
    execFileSync('icacls.exe', [path, '/grant', '*S-1-1-0:F']);
    expect(() => readWindowsEvidence(root, id, 'identity', 100)).toThrow();
    expect(() => removeWindowsEvidence(root, id, 'identity')).toThrow();
    removeWindowsEvidence(root, id, 'processes');
    removeWindowsEvidence(root, id, 'execution');
    expect(readWindowsEvidence(root, id, 'execution', 100)).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 180_000);
