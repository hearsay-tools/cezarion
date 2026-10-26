import { describe, expect, it } from 'vitest';
import { renderHandoffRecords } from '../../handoff.ts';
import { buildPrBody } from './github.ts';

const FOOTER = '\n\n---\n\n🤖 made with cezar';
const journal = (goal: string, log: string) => `# Handoff\n\n## Goal\n\n${goal}\n\n## Progress log\n\n${log}\n## Resume notes\n\nnext: review\n`;

describe('buildPrBody', () => {
  it('takes the Goal and the newest ten Progress log lines', () => {
    const log = Array.from({ length: 12 }, (_, i) => `- 10:${String(11 - i).padStart(2, '0')} — line ${11 - i}`).join('\n');
    const body = buildPrBody(journal('Ship it', `${log}\n`), 'the task');
    expect(body).toBe(`## Goal\n\nShip it\n\n## Progress log\n\n${log.split('\n').slice(0, 10).join('\n')}${FOOTER}`);
  });

  it('falls back to the task and leaves out an empty Progress log', () => {
    expect(buildPrBody('', '  the task \n')).toBe(`## Goal\n\nthe task${FOOTER}`);
    expect(buildPrBody(journal('Ship it', ''), 'the task')).toBe(`## Goal\n\nShip it${FOOTER}`);
  });

  it('reads a header only as a whole line (hearsay-tools/cezarion#1147)', () => {
    const goal = "Shorten the PR body's ## Progress log\nsection.";
    expect(buildPrBody(journal(goal, '- 10:00 — started\n'), 'the task'))
      .toBe(`## Goal\n\n${goal}\n\n## Progress log\n\n- 10:00 — started${FOOTER}`);
  });

  it('reads a journal saved with CRLF endings, and writes the body with LF', () => {
    const crlf = journal('Ship it', '- 10:01 — tests pass\n- 10:00 — started\n').replaceAll('\n', '\r\n');
    expect(buildPrBody(crlf, 'the task')).toBe(`## Goal\n\nShip it\n\n## Progress log\n\n- 10:01 — tests pass\n- 10:00 — started${FOOTER}`);
  });

  it("leaves cezar's records block out of the body (hearsay-tools/cezarion#1809)", () => {
    const records = { autosave: [{ at: '2026-10-25T10:00:00.000Z', note: 'turn end: cezar autosave committed abc1234 on cez/x' }] };
    const text = renderHandoffRecords(journal('Ship it', '- 10:00 — started\n'), records);
    expect(text).toContain('### Autosave');
    expect(buildPrBody(text, 'the task')).toBe(`## Goal\n\nShip it\n\n## Progress log\n\n- 10:00 — started${FOOTER}`);
  });
});
