import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertDarwinMountBoundary, assertMountBoundary, assertNoMountedResource, darwinMountPoints, linuxMountPoints } from './mount-boundary.ts';

describe('Linux mount boundary evidence', () => {
  const line = (id: number, path: string) => `${id} 1 0:1 / ${path} rw - ext4 /dev/example rw`;

  it('recognizes descendant and same-device bind mount paths while allowing ancestors', () => {
    const mounts = linuxMountPoints([line(1, '/'), line(2, '/tmp'), line(3, '/tmp/worker/dir'), line(4, '/tmp/other')].join('\n'));
    expect(() => assertNoMountedResource('/tmp/worker', mounts)).toThrow('Mounted resource boundary');
    expect(() => assertNoMountedResource('/tmp/worker/dir', mounts)).toThrow('Mounted resource boundary');
    expect(() => assertNoMountedResource('/tmp/worker-safe', mounts)).not.toThrow();
  });

  it('decodes escaped spaces and rejects empty or malformed evidence', () => {
    const mounts = linuxMountPoints(line(2, '/tmp/a\\040b/tab\\011dir'));
    expect(() => assertNoMountedResource('/tmp/a b', mounts)).toThrow('Mounted resource boundary');
    expect(() => linuxMountPoints('')).toThrow();
    expect(() => linuxMountPoints(line(1, '/tmp/bad\\777'))).toThrow();
    expect(() => linuxMountPoints('not mountinfo')).toThrow();
  });

  it('rechecks fresh evidence for a later mount and preserves an external marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-mount-boundary-'));
    const marker = join(root, 'marker');
    try {
      writeFileSync(marker, 'untouched');
      const ancestor = line(1, '/');
      expect(() => assertMountBoundary([root], ancestor)).not.toThrow();
      const escaped = root.replace(/\\/g, '\\134').replace(/ /g, '\\040');
      expect(() => assertMountBoundary([root], `${ancestor}\n${line(2, `${escaped}/mounted`)}`)).toThrow('Mounted resource boundary');
      expect(readFileSync(marker, 'utf8')).toBe('untouched');
      expect(() => assertMountBoundary([join(root, 'absent')], ancestor)).not.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('Darwin mount output', () => {
  it('keeps every plausible delimiter interpretation and refuses split records', () => {
    const mounts = darwinMountPoints('/dev/disk on / (apfs, local)\nsource on /tmp/a on /b (c (apfs, local)\n');
    expect(mounts).toContain('/tmp/a on /b (c');
    expect(() => assertNoMountedResource('/tmp/a on /b (c', mounts)).toThrow('Mounted resource boundary');
    expect(() => darwinMountPoints('/dev/disk on / (apfs, local)\nsource on /tmp/a\nname (apfs, local)\n')).toThrow();
    const ambiguous = darwinMountPoints('/dev/disk on / (apfs, local)\nsource on /tmp/a (first)\nsecond on /b (local)\n');
    expect(ambiguous).toContain('/tmp/a (first)\nsecond on /b');
    expect(() => darwinMountPoints('not a mount table')).toThrow();
  });

  it.runIf(process.platform === 'darwin')('accepts an ordinary temporary directory and refuses the mounted root', () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-mac-mount-'));
    try {
      expect(() => assertDarwinMountBoundary([root])).not.toThrow();
      expect(() => assertDarwinMountBoundary(['/'])).toThrow('Mounted resource boundary');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
