import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HANDOFF_INSTRUCTIONS,
  HANDOFF_ONLY_INSTRUCTIONS,
  appendHandoffAutosaveReport,
  appendHandoffHeartbeat,
  handoffPath,
  handoffProgressExcerpt,
  seedHandoffFile,
} from './handoff.ts';
import { todoSchema } from './todos.ts';

/**
 * HANDOFF_INSTRUCTIONS is the only thing that tells an agent what to append to todos.json,
 * so a field can be added to todoSchema and still never be written by anyone. `runnable`
 * shipped exactly that way. This pins the contract instead of the prose: every agent-writable
 * schema field has to appear in the instructions.
 */
describe('HANDOFF_INSTRUCTIONS', () => {
  /** The server assigns these on read/start — an agent never writes them. */
  const SERVER_MANAGED = new Set(['id', 'startedTaskId']);

  it('documents every agent-writable field of todoSchema', () => {
    const undocumented = Object.keys(todoSchema.shape)
      .filter((field) => !SERVER_MANAGED.has(field))
      .filter((field) => !HANDOFF_INSTRUCTIONS.includes(`"${field}"`));

    expect(undocumented).toEqual([]);
  });

  it('tells the agent which way to set runnable, so notes are acknowledged and not run', () => {
    expect(HANDOFF_INSTRUCTIONS).toContain('"runnable": false');
    expect(HANDOFF_INSTRUCTIONS).toContain('"runnable": true');
    expect(HANDOFF_INSTRUCTIONS).toContain('Acknowledge');
  });
});

/**
 * hearsay-tools/cezarion#1004: the autosave report lives in its own section, so
 * the top of the Progress log stays the agent's own summary — the variant
 * compare column (`handoffProgressExcerpt`) and the draft-PR body read it.
 */
describe('appendHandoffAutosaveReport', () => {
  const RUN = 'run-1';
  const REPORT = 'run finalize: cezar autosave committed abc1234 on cez/run-1';
  let dataDir: string;
  const file = () => handoffPath(dataDir, RUN);
  const read = () => readFileSync(file(), 'utf8');
  /** Text of one `## Header` section, up to the next `## ` header. */
  const section = (header: string) => {
    const text = read();
    const start = text.indexOf(`${header}\n`);
    if (start < 0) return '';
    const rest = text.slice(start + header.length + 1);
    const next = rest.indexOf('\n## ');
    return next >= 0 ? rest.slice(0, next) : rest;
  };
  const seed = () => seedHandoffFile(dataDir, { id: RUN, title: 't', workflow: 'quick-task', task: 'do it', branch: 'cez/run-1' });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-handoff-'));
    mkdirSync(join(dataDir, 'runs'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('is not seeded: the section appears only when cezar first reports', () => {
    seed();
    expect(read()).not.toContain('## Autosave (cezar)');
  });

  it('creates the section right before the Progress log, keeping the agent line first there', () => {
    seed();
    appendHandoffHeartbeat(dataDir, RUN, 'implemented the change');

    appendHandoffAutosaveReport(dataDir, RUN, REPORT);

    const text = read();
    const autosave = text.indexOf('## Autosave (cezar)\n');
    expect(autosave).toBeGreaterThan(text.indexOf('## Goal\n'));
    expect(text.indexOf('## Progress log\n')).toBeGreaterThan(autosave);
    expect(section('## Autosave (cezar)')).toMatch(new RegExp(`^\\n- \\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z — ${REPORT}\\n$`));
    expect(section('## Goal')).not.toContain(REPORT);
    expect(section('## Progress log')).not.toContain(REPORT);
    expect(handoffProgressExcerpt(text)).toMatch(/^- \S+ — implemented the change$/);
    expect(text.endsWith('## Resume notes\n')).toBe(true);
  });

  it('inserts newest first under an existing header', () => {
    seed();
    appendHandoffAutosaveReport(dataDir, RUN, 'first report');
    appendHandoffAutosaveReport(dataDir, RUN, 'second report');

    const lines = section('## Autosave (cezar)').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/ — second report$/);
    expect(lines[1]).toMatch(/ — first report$/);
    expect(read().match(/^## Autosave \(cezar\)$/gm)).toHaveLength(1);
    expect(section('## Progress log')).not.toMatch(/report/);
  });

  it('finds an existing section wherever the agent moved it', () => {
    writeFileSync(file(), '# Handoff\n\n## Progress log\n\n- agent line\n\n## Autosave (cezar)\n\n- old report\n');

    appendHandoffAutosaveReport(dataDir, RUN, 'new report');

    expect(read()).toMatch(/## Autosave \(cezar\)\n\n- \S+ — new report\n- old report\n$/);
    expect(handoffProgressExcerpt(read())).toBe('- agent line');
  });

  it('appends the section at the end of a file without a Progress log', () => {
    writeFileSync(file(), '# Handoff\n\nfree-form notes');

    appendHandoffAutosaveReport(dataDir, RUN, REPORT);

    expect(read()).toMatch(new RegExp(`^# Handoff\\n\\nfree-form notes\\n\\n## Autosave \\(cezar\\)\\n\\n- \\S+ — ${REPORT}\\n$`));
  });

  it('is a no-op on a missing file', () => {
    expect(() => appendHandoffAutosaveReport(dataDir, RUN, REPORT)).not.toThrow();
    expect(() => readFileSync(file())).toThrow();
  });

  it('is the section the handoff instructions tell the agent to leave in place', () => {
    seed();
    appendHandoffAutosaveReport(dataDir, RUN, REPORT);
    const header = read().split('\n').find((line) => line.startsWith('## Autosave'));

    expect(HANDOFF_ONLY_INSTRUCTIONS).toContain(`"${header}"`);
    expect(HANDOFF_ONLY_INSTRUCTIONS).toMatch(/"## Autosave \(cezar\)" section[^\n]*leave it in place/);
  });
});
