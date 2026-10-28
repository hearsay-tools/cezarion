import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { darwinDestroyChmod } from './darwin-destroy-chmod.ts';

const source = fileURLToPath(new URL('../../scripts/darwin-destroy-chmod.js', import.meta.url));
describe.runIf(process.platform === 'darwin')('explicit destroy macOS permission repair', () => {
  it('repairs mode 000 and preserves other mode bits', async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-mac-repair-'));
    try {
      for (const mode of [0o000, 0o050]) {
        const path = join(root, String(mode)); mkdirSync(path); chmodSync(path, mode);
        const before = lstatSync(path, { bigint: true }); await darwinDestroyChmod(path);
        const after = lstatSync(path, { bigint: true });
        expect(after.ino).toBe(before.ino); expect(after.dev).toBe(before.dev); expect(Number(after.mode & 0o7777n)).toBe(mode | 0o700);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(['directory', 'symlink'] as const)('refuses a replaced %s after the admitted permission race', kind => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-mac-race-'));
    const target = join(root, 'target'), saved = join(root, 'saved'), victim = join(root, 'victim');
    mkdirSync(target); chmodSync(target, 0); mkdirSync(victim); chmodSync(victim, 0o750);
    const info = lstatSync(target, { bigint: true }); const dev = Buffer.alloc(4), ino = Buffer.alloc(8);
    dev.writeUInt32LE(Number(BigInt.asUintN(32, info.dev))); ino.writeBigUInt64LE(info.ino);
    const fixture = join(root, 'fixture.js');
    const binding = "ObjC.bindFunction('renameat', ['int', ['int', 'char *', 'int', 'char *']]);\nObjC.bindFunction('mkdirat', ['int', ['int', 'char *', 'int']]);\nObjC.bindFunction('symlinkat', ['int', ['char *', 'int', 'char *']]);\n";
    const mutate = kind === 'directory' ? "if ($.mkdirat(fd, name, 0) !== 0) throw Error('fixture mkdir');" : "if ($.symlinkat($('victim').UTF8String, fd, name) !== 0) throw Error('fixture symlink');";
    const hook = `if ($.renameat(fd, name, fd, $('saved').UTF8String) !== 0) throw Error('fixture rename'); ${mutate}\n    `;
    const original = readFileSync(source, 'utf8');
    expect(original.split('if ($.fchmodat(fd, name,')).toHaveLength(2);
    const script = original.replace('function run(args) {', binding + 'function run(args) {').replace('if ($.fchmodat(fd, name,', hook + 'if ($.fchmodat(fd, name,');
    writeFileSync(fixture, script);
    try {
      let stderr = ''; let failure: unknown;
      try { execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', fixture, root, 'target', dev.toString('hex'), ino.toString('hex')], { stdio: 'pipe' }); }
      catch (error) { failure = error; stderr = String((error as { stderr?: Buffer }).stderr ?? error); }
      expect(failure, `osascript unexpectedly succeeded: ${stderr}`).toBeDefined();
      expect(existsSync(saved), `race hook did not save original; osascript stderr: ${stderr}`).toBe(true);
      expect(stderr).toContain(kind === 'directory' ? 'directory identity mismatch after chmod' : 'fchmodat');
      expect(lstatSync(saved).mode & 0o777).toBe(0);
      expect(lstatSync(victim).mode & 0o777).toBe(0o750);
      if (kind === 'directory') expect(lstatSync(target).mode & 0o777).toBe(0o700);
    } finally { if (existsSync(saved)) chmodSync(saved, 0o700); if (existsSync(target) && lstatSync(target).isDirectory()) chmodSync(target, 0o700); rmSync(root, { recursive: true, force: true }); }
  });
  it('refuses an existing symlink and a symlink ancestor', async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-mac-link-'));
    const victim = join(root, 'victim'), link = join(root, 'link');
    mkdirSync(victim); mkdirSync(join(victim, 'child')); chmodSync(join(victim, 'child'), 0o750); chmodSync(victim, 0o750);
    symlinkSync(victim, link);
    try {
      await expect(darwinDestroyChmod(link)).rejects.toThrow();
      await expect(darwinDestroyChmod(join(link, 'child'))).rejects.toThrow();
      expect(lstatSync(victim).mode & 0o777).toBe(0o750);
      expect(lstatSync(join(victim, 'child')).mode & 0o777).toBe(0o750);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('detects a replacement after chmod before reopening', () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-mac-post-'));
    const target = join(root, 'target'), saved = join(root, 'saved');
    mkdirSync(target); chmodSync(target, 0);
    const info = lstatSync(target, { bigint: true }); const dev = Buffer.alloc(4), ino = Buffer.alloc(8);
    dev.writeUInt32LE(Number(BigInt.asUintN(32, info.dev))); ino.writeBigUInt64LE(info.ino);
    const fixture = join(root, 'fixture.js');
    const binding = "ObjC.bindFunction('renameat', ['int', ['int', 'char *', 'int', 'char *']]);\nObjC.bindFunction('mkdirat', ['int', ['int', 'char *', 'int']]);\n";
    const hook = "if ($.renameat(fd, name, fd, $('saved').UTF8String) !== 0 || $.mkdirat(fd, name, 448) !== 0) throw Error('fixture swap');\n    ";
    const script = readFileSync(source, 'utf8').replace('function run(args) {', binding + 'function run(args) {').replace('child = $.openat(fd, name,', hook + 'child = $.openat(fd, name,');
    writeFileSync(fixture, script);
    try {
      expect(() => execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', fixture, root, 'target', dev.toString('hex'), ino.toString('hex')], { stdio: 'pipe' })).toThrow();
      expect(lstatSync(saved).mode & 0o777).toBe(0o700);
      expect(lstatSync(target).ino).not.toBe(info.ino);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('keeps a replaced parent separate and detects the changed path after repair', async () => {
    const base = mkdtempSync(join(realpathSync(tmpdir()), 'cez-mac-parent-race-'));
    const parent = join(base, 'parent'), saved = join(base, 'saved'), name = 'child';
    mkdirSync(parent); mkdirSync(join(parent, name)); chmodSync(join(parent, name), 0);
    const info = lstatSync(join(parent, name), { bigint: true });
    const fixture = join(base, 'fixture.js');
    const binding = "ObjC.bindFunction('rename', ['int', ['char *', 'char *']]);\nObjC.bindFunction('mkdir', ['int', ['char *', 'int']]);\nObjC.bindFunction('mkdirat', ['int', ['int', 'char *', 'int']]);\n";
    const hook = `if ($.rename($(args[0]).UTF8String, $(${JSON.stringify(saved)}).UTF8String) !== 0) throw Error('fixture parent rename'); if ($.mkdir($(args[0]).UTF8String, 448) !== 0) throw Error('fixture parent mkdir'); const other = $.open($(args[0]).UTF8String, 0x60100000, 0); if (other < 0 || $.mkdirat(other, name, 0) !== 0) throw Error('fixture child mkdir'); $.close(other);\n    `;
    const script = readFileSync(source, 'utf8').replace('function run(args) {', binding + 'function run(args) {').replace('if ($.fchmodat(fd, name,', hook + 'if ($.fchmodat(fd, name,');
    writeFileSync(fixture, script);
    const exec = childProcess.execFile;
    const spy = vi.spyOn(childProcess, 'execFile').mockImplementation(((...args: unknown[]) => {
      const argv = args[1] as string[];
      if (args[0] === '/usr/bin/osascript') args[1] = [...argv.slice(0, 2), fixture, ...argv.slice(3)];
      return Reflect.apply(exec, childProcess, args);
    }) as typeof exec);
    syncBuiltinESMExports();
    try {
      await expect(darwinDestroyChmod(join(parent, name))).rejects.toThrow('Directory changed after repair');
      expect(lstatSync(join(saved, name)).mode & 0o777).toBe(0o700);
      const current = lstatSync(join(parent, name), { bigint: true });
      expect(current.ino).not.toBe(info.ino); expect(Number(current.mode & 0o777n)).toBe(0);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); if (existsSync(join(parent, name))) chmodSync(join(parent, name), 0o700); rmSync(base, { recursive: true, force: true }); }
  });

});
