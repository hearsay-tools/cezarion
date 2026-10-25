import { describe, expect, it } from 'vitest';
import { classifyTurnEnd } from './run.ts';
import { ACK_TEXT, ASK_TEXT, MONITORING_TEXT, REJECTED_ASK_TEXT } from './monitoring-turn.testkit.ts';

// The text forms of the monitoring matrices, read by the one turn-end rule that fresh steps and
// Continue share. The native-wire rows in `monitoring-turn.test.ts` and
// `monitoring-channel-order.test.ts` keep one representative form per runner; every other form
// is pinned here (hearsay-tools/cezarion#1665). No prose is read (hearsay-tools/cezarion#1234).

/** How each runner's native wire hands one turn's messages to the two channels. `missing` and
 *  `refresh` are the codex shapes `monitoring-channel-order.test.ts` drives: a completion frame
 *  without its snapshot, and a refresh of the first message's id that carries both texts. */
const CHANNELS = {
  identical: (messages: string[]) => [messages.join('\n'), messages.join('\n')],
  missing: (messages: string[]) => [messages.join('\n'), messages.filter((_, n) => n !== 1).join('\n')],
  refresh: (messages: string[]) => [messages.filter((_, n) => n !== 1).join('\n'), [messages[0], `${messages[0]}\n${messages[1]}`, ...messages.slice(2)].join('\n')],
} as const satisfies Record<string, (messages: string[]) => [string, string]>;

function read(messages: string[], { channel = 'identical', liveWorkers = false }: { channel?: keyof typeof CHANNELS; liveWorkers?: boolean } = {}) {
  const [v1, v2] = CHANNELS[channel](messages);
  return classifyTurnEnd(v1, v2, { sessionOpen: true, pendingHumanAsk: false, scheduledWake: false, liveWorkers });
}
const QUESTIONS = JSON.parse(ASK_TEXT.slice('CEZ:ASK '.length)).questions;
const DANGER = [expect.objectContaining({ tone: 'danger' })];
const monitoringOnly = { monitoring: true, done: false, ask: null, humanGate: false, notes: [] };

describe('turn-end text forms (hearsay-tools/cezarion#1665)', () => {
  // M2, M3: questions and review requests in prose, plain or in Markdown, leave the line's timer.
  const QUESTIONS_IN_PROSE = ['Should I merge this PR?', 'The checks passed. Do you want me to merge?', 'Which module?', 'Is this okay?',
    '### Should I merge this PR?', '- Should I merge this PR?', '*Should I merge this PR?* Please let me know.'];
  const REVIEWS_IN_PROSE = ['Please review the changes before I continue.', 'The checks passed. I need your approval before proceeding.',
    'The PR is ready for your review.', '- [ ] Please review the changes before I continue.', '**Please review the changes before I continue.**',
    '1. __I need your approval before proceeding.__'];
  for (const gate of QUESTIONS_IN_PROSE) it(`M2 a later prose question keeps monitoring: ${JSON.stringify(gate)}`, () => {
    expect(read([MONITORING_TEXT, gate])).toMatchObject(monitoringOnly);
  });
  for (const gate of REVIEWS_IN_PROSE) for (const liveWorkers of [true, false]) it(`M3 a later prose review request keeps monitoring${liveWorkers ? ' with live workers' : ''}: ${JSON.stringify(gate)}`, () => {
    expect(read([MONITORING_TEXT, gate], { liveWorkers })).toMatchObject(monitoringOnly);
  });

  // M6: a quoted, fenced or example monitoring line declares nothing.
  for (const example of ['Use `CEZ:MONITORING` in your reply.', '> CEZ:MONITORING', 'Example:\n```text\nCEZ:MONITORING\n```', 'Example:\n    CEZ:MONITORING', 'Example:\nCEZ:MONITORING']) {
    it(`M6 an inert monitoring example: ${JSON.stringify(example)}`, () => {
      expect(read([example])).toMatchObject({ monitoring: false, done: false, ask: null, humanGate: false, notes: [] });
    });
  }

  // M20: quoted, fenced, indented and example ASK and DONE lines stay inert, mid-turn and last.
  const INERT = [`> ${REJECTED_ASK_TEXT}`, `Example:\n${REJECTED_ASK_TEXT}`, `\`\`\`text\n${REJECTED_ASK_TEXT}\n\`\`\``, `> ${ASK_TEXT}`,
    `\`\`\`text\n${ASK_TEXT}\nCEZ:DONE\n\`\`\``, `Example:\n${ASK_TEXT}`, 'Example:\nCEZ:DONE', `    ${ASK_TEXT}`, '    CEZ:DONE'];
  for (const example of INERT) it(`M20 an inert declaration before acknowledgement: ${JSON.stringify(example)}`, () => {
    expect(read([MONITORING_TEXT, example, ACK_TEXT])).toMatchObject(monitoringOnly);
  });
  for (const example of [`Example:\n${ASK_TEXT}`, 'Example:\nCEZ:DONE']) it(`M20 an inert declaration at the final line: ${JSON.stringify(example)}`, () => {
    expect(read([MONITORING_TEXT, example])).toMatchObject(monitoringOnly);
  });

  // M18: an active ASK survives later acknowledgement, a later monitoring line, an earlier DONE and earlier examples.
  for (const messages of [[MONITORING_TEXT, ASK_TEXT, ACK_TEXT], [MONITORING_TEXT, 'CEZ:DONE', ASK_TEXT, ACK_TEXT], [MONITORING_TEXT, ASK_TEXT, ACK_TEXT, MONITORING_TEXT],
    [MONITORING_TEXT, `Example:\n\`\`\`text\n${ASK_TEXT}\n\`\`\``, ASK_TEXT, ACK_TEXT], [MONITORING_TEXT, `Example:\n> ${ASK_TEXT}`, ASK_TEXT, ACK_TEXT],
    [MONITORING_TEXT, `Example:\n    ${ASK_TEXT}`, ASK_TEXT, ACK_TEXT]]) {
    it(`M18 a structured ASK beats monitoring: ${JSON.stringify(messages.slice(1, -1))}`, () => {
      expect(read(messages)).toMatchObject({ monitoring: false, done: false, ask: { questions: QUESTIONS }, notes: [] });
    });
  }

  // M29, M30: a later declaration in either channel shape precedes a gate that only the other channel kept.
  const GATE = 'Please review the changes before I continue.';
  for (const channel of ['identical', 'missing', 'refresh'] as const) {
    it(`M29 ${channel}: a later monitoring line keeps monitoring after resolved prose`, () => {
      expect(read([GATE, 'CEZ:MONITORING', ACK_TEXT], { channel })).toMatchObject(monitoringOnly);
    });
    it(`M29 ${channel}: an earlier structured ASK is retained over a later monitoring line`, () => {
      expect(read([ASK_TEXT, 'CEZ:MONITORING', ACK_TEXT], { channel })).toMatchObject({ monitoring: false, done: false, ask: { questions: QUESTIONS } });
    });
    it(`M29 ${channel}: an earlier rejected ASK keeps its diagnostic`, () => {
      expect(read([REJECTED_ASK_TEXT, 'CEZ:MONITORING', ACK_TEXT], { channel })).toMatchObject({ done: false, ask: null, notes: DANGER });
    });
    for (const earlier of [GATE, ASK_TEXT, REJECTED_ASK_TEXT]) it(`M30 ${channel}: a later DONE supersedes ${JSON.stringify(earlier.slice(0, 24))}`, () => {
      expect(read([earlier, 'CEZ:DONE', ACK_TEXT], { channel })).toMatchObject({ done: true, monitoring: false, ask: null, notes: [] });
    });
  }
});
