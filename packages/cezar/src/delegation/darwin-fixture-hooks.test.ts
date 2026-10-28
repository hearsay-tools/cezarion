import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { preChmodRaceFixture } from './darwin-race-fixture.testkit.ts';

it('pins the private race fixture sequence and each immediate native failure', () => {
  const source = readFileSync(new URL('../../scripts/darwin-destroy-chmod.js', import.meta.url), 'utf8');
  const replacement = "if ($.mkdirat(fd, name, 0) !== 0) failure('fixture mkdirat');";
  const patched = preChmodRaceFixture(source, 'saved', replacement);
  const steps = ['directory identity mismatch\');', "failure('fixture grant fchmodat')", "failure('fixture openat')",
    "failure('fixture fstat granted')", "failure('fixture renameat')", "failure('fixture restore fchmod')",
    "failure('fixture fstat restored')", "failure('fixture saved fstatat')", replacement,
    "failure('fixture boundary fstatat')", "failure('fchmodat')", "failure('reopen')", 'directory identity mismatch after chmod'];
  let last = -1;
  for (const step of steps) { const position = patched.indexOf(step); expect(position, step).toBeGreaterThan(last); last = position; }
  expect(patched).toContain('$.openat(fd, name, 0x20100000, 0)');
  expect(patched).toContain("$.fchmodat(fd, name, (before.mode & 0o7777) | 0o700, 0x800)");
  expect(() => preChmodRaceFixture(source + source, 'saved', replacement)).toThrow('fixture marker changed');
  const service = readFileSync(new URL('./service.test.ts', import.meta.url), 'utf8');
  const unit = readFileSync(new URL('./darwin-destroy-chmod.test.ts', import.meta.url), 'utf8');
  expect(service).toContain("error: expect.stringContaining('directory identity mismatch')");
  expect(unit).toContain("'directory identity mismatch after chmod' : 'fchmodat'");
  expect(unit).toContain("failure('fixture symlinkat')");
  expect(unit).toContain('expect(victimAfter.ino).toBe(victimInfo.ino)');
  expect(unit).toContain('expect(replacementInfo.isSymbolicLink()).toBe(true)');
});
