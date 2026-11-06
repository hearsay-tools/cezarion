import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { activityPrProgressSchema } from '@open-mercato/cezar-contract/activity';
import { ActivityDemand, HTTP_DEMAND_MS } from '../activity/demand.ts';
import type { GithubCheck } from './github.ts';
import { checkProgress, CiProgressRegistry, DemandSlot } from './progress.ts';

const everyoneWatches = () => {
  const registry = new CiProgressRegistry();
  registry.useDemand({ has: () => true });
  return registry;
};
const row = (name: string, bucket: GithubCheck['bucket']): GithubCheck => ({ name, state: bucket.toUpperCase(), link: '', bucket });

/** The activity view's check progress (spec 2026-11-05-live-activity-view, CI check progress). */
describe('the bucket count', () => {
  it('counts all five buckets and lists the checks in name order', () => {
    const progress = checkProgress([row('test', 'pending'), row('build', 'pass'), row('lint', 'fail'), row('docs', 'skipping'), row('e2e', 'cancel'), row('audit', 'pass')]);
    expect(activityPrProgressSchema.parse(progress)).toEqual({
      checks: [{ name: 'audit', bucket: 'pass' }, { name: 'build', bucket: 'pass' }, { name: 'docs', bucket: 'skipping' }, { name: 'e2e', bucket: 'cancel' },
        { name: 'lint', bucket: 'fail' }, { name: 'test', bucket: 'pending' }],
      counts: { pass: 2, fail: 1, pending: 1, skipping: 1, cancel: 1 },
    });
  });

  it('counts every check before it cuts the list: 101 checks with the last one pending say 100 of 101', () => {
    const rows = Array.from({ length: 101 }, (_, index) => row(`check-${String(index).padStart(3, '0')}`, index === 100 ? 'pending' : 'pass'));
    const progress = activityPrProgressSchema.parse(checkProgress(rows));
    expect(progress.counts).toEqual({ pass: 100, fail: 0, pending: 1, skipping: 0, cancel: 0 });
    expect(progress.checks).toHaveLength(100);
    expect(progress.checks.every((check) => check.bucket === 'pass')).toBe(true);
    expect(progress.truncated).toBe(true);
  });

  it('cleans terminal escapes out of a name and clamps it to 100 characters', () => {
    const [check] = checkProgress([row(`\x1b[31mred\x1b[0m ${'x'.repeat(200)}`, 'fail')]).checks;
    expect(check!.name).toBe(`red ${'x'.repeat(96)}`);
  });

  it('reads no checks yet as empty counts', () => {
    expect(checkProgress([])).toEqual({ checks: [], counts: { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 } });
  });
});

describe('the progress registry', () => {
  it('holds the latest read: a check moves from pending to pass between two snapshots', () => {
    const registry = new CiProgressRegistry();
    const waitId = randomUUID();
    registry.publish(waitId, [row('build', 'pending')]);
    expect(registry.read(waitId, 'shop')?.checks).toEqual([{ name: 'build', bucket: 'pending' }]);
    registry.publish(waitId, [row('build', 'pass')]);
    expect(registry.read(waitId, 'shop')).toEqual({ checks: [{ name: 'build', bucket: 'pass' }], counts: { pass: 1, fail: 0, pending: 0, skipping: 0, cancel: 0 } });
  });

  it('wants a wait while its project has demand, from the snapshot that read it, and 15 s after the last HTTP read', () => {
    let now = 1_000;
    const demand = new ActivityDemand(() => now);
    const registry = new CiProgressRegistry();
    registry.useDemand(demand);
    const waitId = randomUUID();
    registry.publish(waitId, [row('build', 'pending')]);
    demand.markRead('shop');
    // No snapshot has read the wait yet: its project is unknown.
    expect(registry.wanted(waitId)).toBe(false);
    registry.read(waitId, 'shop');
    expect(registry.wanted(waitId)).toBe(true);
    now += HTTP_DEMAND_MS;
    expect(registry.wanted(waitId)).toBe(false);
    // Demand for another project is not demand for this wait.
    demand.markRead('docs');
    expect(registry.wanted(waitId)).toBe(false);
  });

  it('records nothing for a wait this process does not watch', () => {
    const registry = everyoneWatches();
    const waitId = randomUUID();
    expect(registry.read(waitId, 'shop')).toBeUndefined();
    expect(registry.wanted(waitId)).toBe(false);
    // A later publish starts without a project: the next snapshot read gives it one.
    registry.publish(waitId, []);
    expect(registry.wanted(waitId)).toBe(false);
  });

  it('forgets a removed wait, its project included; a new registry starts empty', () => {
    const registry = everyoneWatches();
    const waitId = randomUUID();
    registry.publish(waitId, [row('build', 'pass')]);
    registry.read(waitId, 'shop');
    registry.remove(waitId);
    expect(registry.read(waitId, 'shop')).toBeUndefined();
    expect(registry.wanted(waitId)).toBe(false);
    expect(everyoneWatches().read(waitId, 'shop')).toBeUndefined();
  });
});

describe('the progress registry change signal', () => {
  it('signals a changed progress and a removed entry, and nothing else', () => {
    const registry = new CiProgressRegistry();
    let changes = 0;
    const release = registry.onChange(() => { changes++; });
    const pending: GithubCheck = { name: 'build', state: 'PENDING', link: '', bucket: 'pending' };
    registry.publish('wait', [pending]);
    registry.publish('wait', [pending]); // the same read again changes nothing
    registry.publish('wait', [{ ...pending, state: 'SUCCESS', bucket: 'pass' }]);
    registry.remove('wait');
    registry.remove('wait');
    expect(changes).toBe(3);
    release();
    registry.publish('wait', [pending]);
    expect(changes).toBe(3);
  });
});

describe('the demand slot', () => {
  it('reads no demand until the activity view plugs one in, and none after its release', () => {
    const registry = new CiProgressRegistry();
    const waitId = randomUUID();
    registry.publish(waitId, []);
    registry.read(waitId, 'shop');
    expect(registry.wanted(waitId)).toBe(false);
    const release = registry.useDemand({ has: () => true });
    expect(registry.wanted(waitId)).toBe(true);
    release();
    expect(registry.wanted(waitId)).toBe(false);
  });

  it('reads the demand plugged in last, and nothing once it is released', () => {
    const slot = new DemandSlot();
    expect(slot.has('shop')).toBe(false);
    const first = slot.use({ has: (projectId) => projectId === 'shop' });
    expect(slot.has('shop')).toBe(true);
    const second = slot.use({ has: (projectId) => projectId === 'docs' });
    expect([slot.has('shop'), slot.has('docs')]).toEqual([false, true]);
    // An older cockpit's release leaves the newer demand in place.
    first();
    expect(slot.has('docs')).toBe(true);
    second();
    expect(slot.has('docs')).toBe(false);
  });
});
