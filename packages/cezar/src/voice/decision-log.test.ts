import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VoiceDecision } from '@open-mercato/cezar-contract/voice';
import { appendVoiceLog, RecentVoiceActions, type VoiceLogLine } from './decision-log.ts';

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

describe('RecentVoiceActions.load (seeded from the log, spec "from the decision log")', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-voice-load-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  const decision = (id: string, sentence: string): VoiceLogLine => {
    const chosen: VoiceDecision = { action: 'open', decisionId: id, status: 'finished', position: 'next', confidence: 0.9 };
    return {
      type: 'decision',
      at: '2026-10-21T10:00:00.000Z',
      decisionId: id,
      sentence,
      engine: 'fake',
      state: { sentence, words: [], screen: { page: 'task', sidebarView: 'active', project: 'cezar' }, recent: [] },
      answers: {},
      decision: chosen,
      latencyMs: 1,
    };
  };
  const outcome = (id: string, value: 'executed' | 'abandoned'): VoiceLogLine => ({
    type: 'outcome',
    at: '2026-10-21T10:00:01.000Z',
    decisionId: id,
    outcome: value,
  });
  const logPath = () => join(dataDir, 'voice', 'decisions.ndjson');

  it('survives a restart: a new instance reads the decision and its outcome', () => {
    appendVoiceLog(dataDir, decision('d1', 'open next finished'));
    appendVoiceLog(dataDir, outcome('d1', 'executed'));
    const restarted = new RecentVoiceActions();
    restarted.load('p', dataDir);
    expect(restarted.last('p')).toEqual([{ sentence: 'open next finished', action: 'open', outcome: 'executed' }]);
  });

  it('skips a damaged line, a decision-error line and a wrong shape between valid ones', () => {
    appendVoiceLog(dataDir, decision('d1', 'first'));
    appendFileSync(logPath(), 'not json at all\n');
    appendFileSync(logPath(), `${JSON.stringify({ type: 'decision', decisionId: 'x' })}\n`);
    appendVoiceLog(dataDir, { type: 'decision-error', at: '2026-10-21T10:00:00.000Z', decisionId: 'e', sentence: 'boom', code: 'http' });
    appendVoiceLog(dataDir, decision('d2', 'second'));
    const recent = new RecentVoiceActions();
    recent.load('p', dataDir);
    expect(recent.last('p', 10).map((e) => e.sentence)).toEqual(['first', 'second']);
  });

  it('seeds nothing from a missing file and never throws', () => {
    const recent = new RecentVoiceActions();
    expect(() => recent.load('p', join(dataDir, 'nowhere'))).not.toThrow();
    expect(recent.last('p')).toEqual([]);
  });

  it('reads the log once per project: a second load adds nothing', () => {
    appendVoiceLog(dataDir, decision('d1', 'only'));
    const recent = new RecentVoiceActions();
    recent.load('p', dataDir);
    recent.load('p', dataDir);
    expect(recent.last('p', 10)).toHaveLength(1);
    appendVoiceLog(dataDir, decision('d2', 'later'));
    recent.load('p', dataDir);
    expect(recent.last('p', 10)).toHaveLength(1);
  });

  it('reads only the tail of a log larger than 64 KiB and still yields the newest entries', () => {
    for (let n = 0; n < 400; n++) appendVoiceLog(dataDir, decision(`d${n}`, `sentence ${n} ${'x'.repeat(200)}`));
    appendVoiceLog(dataDir, outcome('d399', 'executed'));
    expect(readFileSync(logPath()).length).toBeGreaterThan(65536);
    const recent = new RecentVoiceActions();
    recent.load('p', dataDir);
    const last = recent.last('p', 10);
    expect(last).toHaveLength(10);
    expect(last.at(-1)).toMatchObject({ outcome: 'executed' });
    expect(last[0]!.sentence.startsWith('sentence 390 ')).toBe(true);
  });
});
