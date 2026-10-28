import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('reports each fixture syscall failure before its next native call', () => {
  const unit = readFileSync(new URL('./darwin-destroy-chmod.test.ts', import.meta.url), 'utf8');
  const service = readFileSync(new URL('./service.test.ts', import.meta.url), 'utf8');
  expect(unit).toContain("if ($.renameat(fd, name, fd, $('saved').UTF8String) !== 0) failure('fixture renameat'); ${mutate}");
  expect(unit).toContain("if ($.mkdirat(fd, name, 0) !== 0) failure('fixture mkdirat');");
  expect(unit).toContain("if ($.symlinkat($('victim').UTF8String, fd, name) !== 0) failure('fixture symlinkat');");
  expect(unit).toContain("if ($.renameat(fd, name, fd, $('saved').UTF8String) !== 0) failure('fixture renameat'); if ($.mkdirat(fd, name, 448) !== 0) failure('fixture mkdirat');");
  expect(unit).toContain("if (other < 0) failure('fixture parent open'); if ($.mkdirat(other, name, 0) !== 0) failure('fixture child mkdirat'); $.close(other);");
  expect(service).toContain("if ($.renameat(fd, name, fd, $('.ai-saved').UTF8String) !== 0) failure('fixture renameat'); if ($.mkdirat(fd, name, 0) !== 0) failure('fixture mkdirat');");
  expect(unit).toContain(".replace('if ($.fchmodat(fd, name,', hook + 'if ($.fchmodat(fd, name,')");
  expect(service).toContain("error: expect.stringContaining('directory identity mismatch')");
  expect(unit).toContain("'directory identity mismatch after chmod' : 'fchmodat'");
  expect(unit).toContain('expect(lstatSync(victim).mode & 0o777).toBe(0o750)');
});
