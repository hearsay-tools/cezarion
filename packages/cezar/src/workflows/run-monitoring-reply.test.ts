import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import { setupMonitoringFixture } from './run-fixture.testkit.ts';
describe('RunManager monitoring reply', () => {
  const fixture = setupMonitoringFixture();
  const { SINGLE_STEP, waitFor, openTimer } = fixture;
  it('a user reply to a monitoring run keeps its timer (hearsay-tools/cezarion#1233)', async () => {
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'mock:cezar-wait keep going', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting' && Boolean(openTimer(r)));
    const timer = openTimer(fixture.store.getRun(record.id))?.id;
    // A user reply (no marker) resumes the run; the follow-up turn re-parks on the same timer.
    const boundaries = () => readFileSync(join(fixture.repoRoot, '.ai/cezar/runs', `${record.id}.ndjson`), 'utf8').split('"type":"turn-end"').length;
    const before = boundaries();
    expect(fixture.manager.sendMessage(record.id, [{ type: 'text', text: 'thanks, carry on' }])).toBe(true);
    await waitFor(record.id, (r) => r?.status === 'waiting' && boundaries() > before);
    expect(openTimer(fixture.store.getRun(record.id))?.id).toBe(timer);
    expect(deriveAttention(fixture.store.getRun(record.id)!).label).toBe('monitoring');
  }, 30_000);
});
