import { describe, expect, it } from 'vitest';
import {
  VOICE_STATUS_DESCRIPTIONS,
  VOICE_STATUS_IDS,
  voiceDecideRequestSchema,
  voiceDecisionSchema,
  voicePositionSchema,
} from './voice.ts';

const id = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';

describe('voice contract', () => {
  it('accepts a decide request and trims the text', () => {
    const parsed = voiceDecideRequestSchema.parse({ text: '  open next finished ', sidebarView: 'active' });
    expect(parsed.text).toBe('open next finished');
  });

  it('refuses empty, overlong and unknown-key requests', () => {
    const base = { text: 'open', sidebarView: 'active' };
    expect(voiceDecideRequestSchema.safeParse({ ...base, text: '' }).success).toBe(false);
    expect(voiceDecideRequestSchema.safeParse({ ...base, text: '   ' }).success).toBe(false);
    expect(voiceDecideRequestSchema.safeParse({ ...base, text: 'a'.repeat(501) }).success).toBe(false);
    expect(voiceDecideRequestSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });

  it('positions take next, previous, last and 1–10 only', () => {
    expect(voicePositionSchema.safeParse('next').success).toBe(true);
    expect(voicePositionSchema.safeParse(3).success).toBe(true);
    expect(voicePositionSchema.safeParse(0).success).toBe(false);
    expect(voicePositionSchema.safeParse(11).success).toBe(false);
    expect(voicePositionSchema.safeParse('first').success).toBe(false);
  });

  it('every status has a description', () => {
    for (const status of VOICE_STATUS_IDS) {
      expect(VOICE_STATUS_DESCRIPTIONS[status].length).toBeGreaterThan(0);
    }
  });

  it('describes every worker-wait meaning of waiting-on-workers', () => {
    // The status covers "waiting on N workers", "waiting on worker replies" and "waiting on parent reply".
    const text = VOICE_STATUS_DESCRIPTIONS['waiting-on-workers'];
    expect(text).toMatch(/workers they started/);
    expect(text).toMatch(/replies from their workers/);
    expect(text).toMatch(/reply from their parent/);
  });

  it('decision arms parse and keep their discriminant', () => {
    const samples = [
      { action: 'open', decisionId: id, status: 'finished', position: 'next', confidence: 0.9 },
      {
        action: 'answer',
        decisionId: id,
        runId: 'run-1',
        askRequestId: 'ask-1',
        answers: [
          { question: 0, kind: 'option', labels: ['Yes'] },
          { question: 1, kind: 'other', text: 'something else' },
        ],
        confidence: 0.8,
      },
      { action: 'tell', decisionId: id, runId: 'run-1', text: 'hello', confidence: 0.7 },
      { action: 'confirm', decisionId: id },
      { action: 'cancel', decisionId: id },
      { action: 'none', decisionId: id, reason: 'not-a-command' },
    ];
    for (const sample of samples) {
      const parsed = voiceDecisionSchema.parse(sample);
      expect(parsed.action).toBe(sample.action);
    }
    expect(voiceDecisionSchema.safeParse({ action: 'none', decisionId: id, reason: 'maybe' }).success).toBe(false);
  });
});
