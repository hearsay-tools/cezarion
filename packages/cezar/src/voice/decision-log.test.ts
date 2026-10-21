import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendVoiceLog, RecentVoiceActions } from './decision-log.ts';

describe('appendVoiceLog', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-voice-log-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('appends one line per call', () => {
    appendVoiceLog(dataDir, { type: 'outcome', at: '2026-10-21T10:00:00.000Z', decisionId: 'a', outcome: 'executed' });
    appendVoiceLog(dataDir, { type: 'decision-error', at: '2026-10-21T10:00:01.000Z', decisionId: 'b', sentence: 'open next', code: 'timeout' });
    const raw = readFileSync(join(dataDir, 'voice', 'decisions.ndjson'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.trimEnd().split('\n').map((l) => JSON.parse(l))).toEqual([
      { type: 'outcome', at: '2026-10-21T10:00:00.000Z', decisionId: 'a', outcome: 'executed' },
      { type: 'decision-error', at: '2026-10-21T10:00:01.000Z', decisionId: 'b', sentence: 'open next', code: 'timeout' },
    ]);
  });

  it('never throws on an unwritable directory', () => {
    // `voice` is a file, so the directory cannot be created or written into.
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'voice'), 'not a directory');
    expect(() =>
      appendVoiceLog(dataDir, { type: 'outcome', at: '2026-10-21T10:00:00.000Z', decisionId: 'a', outcome: 'abandoned' }),
    ).not.toThrow();
  });
});

describe('RecentVoiceActions', () => {
  it('last returns the three newest with outcomes', () => {
    const recent = new RecentVoiceActions();
    for (const n of [1, 2, 3, 4]) recent.record('p', `d${n}`, `sentence ${n}`, 'open');
    recent.settle('p', 'd3', 'executed');
    expect(recent.last('p')).toEqual([
      { sentence: 'sentence 2', action: 'open' },
      { sentence: 'sentence 3', action: 'open', outcome: 'executed' },
      { sentence: 'sentence 4', action: 'open' },
    ]);
    expect(recent.last('p', 1)).toEqual([{ sentence: 'sentence 4', action: 'open' }]);
  });

  it('keeps ten per project and ignores an unknown decision', () => {
    const recent = new RecentVoiceActions();
    for (let n = 0; n < 12; n++) recent.record('p', `d${n}`, `s${n}`, 'none');
    recent.record('q', 'x', 'other project', 'tell');
    recent.settle('p', 'nope', 'executed');
    recent.settle('p', 'd0', 'executed'); // already forgotten
    const all = recent.last('p', 100);
    expect(all.map((e) => e.sentence)).toEqual(Array.from({ length: 10 }, (_, i) => `s${i + 2}`));
    expect(all.some((e) => e.outcome !== undefined)).toBe(false);
    expect(recent.last('q')).toEqual([{ sentence: 'other project', action: 'tell' }]);
    expect(recent.last('missing')).toEqual([]);
  });
});
