import { describe, expect, it } from 'vitest';
import { supervisorGone } from './supervisor.ts';
describe('desktop supervisor liveness', () => {
  const alive = (() => true) as typeof process.kill;
  it('detects reparenting even if a PID has been reused', () => expect(supervisorGone(22, 22, 1, alive)).toBe(true));
  it('does not kill a service already adopted at startup', () => expect(supervisorGone(22, 1, 1, alive)).toBe(false));
  it('requires ESRCH, not EPERM', () => {
    for (const code of ['ESRCH', 'EPERM']) {
      const probe = (() => { throw Object.assign(new Error(), { code }); }) as typeof process.kill;
      expect(supervisorGone(22, 22, 22, probe)).toBe(code === 'ESRCH');
    }
  });
});
