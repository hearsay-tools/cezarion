import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_CONTEXT_LIMIT_BYTES,
  SESSION_CONTEXT_SEPARATOR,
  buildSessionContext,
  formatSessionContextReport,
  loadSessionContextRules,
  type SessionContextInput,
} from './session-context.ts';

let root: string;
let project: string;
let worktree: string;
let handoff: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-session-context-'));
  project = join(root, 'project');
  worktree = join(root, 'worktree');
  mkdirSync(join(project, '.ai/cezar/runs'), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  handoff = join(project, '.ai/cezar/runs/run-1.handoff.md');
  writeFileSync(handoff, '# Handoff\n\n## Progress log\n\n## Resume notes\nNext: tests.\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function rules(yaml: string): void {
  writeFileSync(join(project, '.ai/cezar/context.yaml'), yaml);
}

function input(overrides: Partial<SessionContextInput> = {}): SessionContextInput {
  return {
    projectRoot: project,
    cwd: worktree,
    role: 'parent',
    handoffPath: handoff,
    variables: {
      task: 'Fix the bug', 'run.id': 'run-1', role: 'parent', 'workflow.name': 'quick-task', 'step.id': 'task',
      'project.root': project, 'worktree.root': worktree, 'handoff.path': handoff,
    },
    ...overrides,
  };
}

function rule(id: string, template: string, target = 'both'): string {
  return `  - id: ${id}\n    on: session_start\n    target: ${target}\n    template: ${JSON.stringify(template)}\n`;
}

const byId = (context: ReturnType<typeof buildSessionContext>, id: string) => context.reports.find((report) => report.id === id);

describe('session context: handoff', () => {
  it('injects the whole handoff with no configuration and reports it', () => {
    const context = buildSessionContext(input());
    expect(context.handoffInjected).toBe(true);
    expect(context.prefix).toBe(
      `<cezar-context id="handoff" source="${handoff}">\n# Handoff\n\n## Progress log\n\n## Resume notes\nNext: tests.\n</cezar-context>${SESSION_CONTEXT_SEPARATOR}`,
    );
    expect(context.reports).toEqual([{ id: 'handoff', status: 'applied', sources: [handoff], bytes: expect.any(Number) }]);
  });

  it('keeps the read fallback when the handoff is missing', () => {
    rmSync(handoff);
    const context = buildSessionContext(input());
    expect(context).toMatchObject({ prefix: '', handoffInjected: false });
    expect(byId(context, 'handoff')).toMatchObject({ status: 'skipped', reason: 'not found' });
  });

  it('skips an oversized handoff whole and still applies later rules', () => {
    writeFileSync(handoff, 'h'.repeat(SESSION_CONTEXT_LIMIT_BYTES));
    rules(`version: 1\nrules:\n${rule('vision', 'Vision text')}`);
    const context = buildSessionContext(input());
    expect(context.handoffInjected).toBe(false);
    expect(byId(context, 'handoff')).toMatchObject({ status: 'skipped' });
    expect(context.prefix).toBe(`<cezar-context id="vision">\nVision text\n</cezar-context>${SESSION_CONTEXT_SEPARATOR}`);
  });

  it('skips a handoff that is not valid UTF-8', () => {
    writeFileSync(handoff, Buffer.from([0xff, 0xfe, 0x00]));
    expect(byId(buildSessionContext(input()), 'handoff')).toMatchObject({ status: 'skipped', reason: 'not valid UTF-8' });
  });
});

describe('session context: budget', () => {
  // The whole prefix, labels and separators included, against the cap.
  function fill(bytes: number, char = 'x'): string {
    const handoffBlock = buildSessionContext(input()).prefix.length - SESSION_CONTEXT_SEPARATOR.length;
    const overhead = handoffBlock + '\n\n<cezar-context id="fill">\n\n</cezar-context>'.length + SESSION_CONTEXT_SEPARATOR.length;
    return char.repeat((bytes - overhead) / Buffer.byteLength(char));
  }

  it('applies a block that makes the prefix exactly the limit', () => {
    writeFileSync(join(worktree, 'fill.txt'), fill(SESSION_CONTEXT_LIMIT_BYTES));
    rules(`version: 1\nrules:\n${rule('fill', '{{file:fill.txt}}')}`);
    const context = buildSessionContext(input());
    expect(byId(context, 'fill')?.status).toBe('applied');
    expect(Buffer.byteLength(context.prefix, 'utf8')).toBe(SESSION_CONTEXT_LIMIT_BYTES);
  });

  it('skips a block one byte over the limit, without truncating, and tries later rules', () => {
    writeFileSync(join(worktree, 'fill.txt'), fill(SESSION_CONTEXT_LIMIT_BYTES + 1));
    rules(`version: 1\nrules:\n${rule('fill', '{{file:fill.txt}}')}${rule('small', 'Small rule')}`);
    const context = buildSessionContext(input());
    expect(byId(context, 'fill')).toMatchObject({ status: 'skipped', reason: expect.stringContaining('limit') });
    expect(byId(context, 'small')?.status).toBe('applied');
    expect(context.prefix).not.toContain('xxxx');
  });

  it('counts UTF-8 bytes, not characters', () => {
    // 4-byte characters: the prefix is within the limit in characters but over it in bytes.
    const fourByte = '😀';
    const handoffBlock = buildSessionContext(input()).prefix.length - SESSION_CONTEXT_SEPARATOR.length;
    const overhead = handoffBlock + '\n\n<cezar-context id="fill">\n\n</cezar-context>'.length + SESSION_CONTEXT_SEPARATOR.length;
    writeFileSync(join(worktree, 'fill.txt'), fourByte.repeat(Math.floor((SESSION_CONTEXT_LIMIT_BYTES - overhead) / 4) + 1));
    rules(`version: 1\nrules:\n${rule('fill', '{{file:fill.txt}}')}`);
    expect(byId(buildSessionContext(input()), 'fill')?.status).toBe('skipped');
    writeFileSync(join(worktree, 'fill.txt'), fourByte.repeat(Math.floor((SESSION_CONTEXT_LIMIT_BYTES - overhead) / 4)));
    expect(byId(buildSessionContext(input()), 'fill')?.status).toBe('applied');
  });

  it('puts the handoff first, then rules in file order', () => {
    rules(`version: 1\nrules:\n${rule('second', 'B')}${rule('first', 'A')}`);
    const prefix = buildSessionContext(input()).prefix;
    expect(prefix.indexOf('id="handoff"')).toBeLessThan(prefix.indexOf('id="second"'));
    expect(prefix.indexOf('id="second"')).toBeLessThan(prefix.indexOf('id="first"'));
  });
});

describe('session context: configuration', () => {
  it('treats a missing file as no rules and no warning', () => {
    expect(loadSessionContextRules(project)).toEqual({ rules: [], reports: [] });
  });

  it.each([
    ['invalid YAML', 'version: 1\nrules: [\n', /invalid YAML/],
    ['an unsupported version', 'version: 2\nrules: []\n', /unsupported version 2/],
    ['a missing version', 'rules: []\n', /unsupported version null/],
    ['a non-list rules key', 'version: 1\nrules: nope\n', /rules must be a list/],
    ['a scalar document', 'just text\n', /expected a mapping/],
  ])('skips every custom rule on %s and keeps the handoff', (_name, yaml, reason) => {
    rules(yaml);
    const context = buildSessionContext(input());
    expect(context.handoffInjected).toBe(true);
    expect(byId(context, 'context.yaml')).toMatchObject({ status: 'skipped', reason: expect.stringMatching(reason) });
  });

  it('skips a context.yaml that is not readable', () => {
    mkdirSync(join(project, '.ai/cezar/context.yaml'));
    expect(loadSessionContextRules(project).reports).toEqual([
      expect.objectContaining({ id: 'context.yaml', status: 'skipped', reason: expect.stringContaining('is a directory') }),
    ]);
  });

  it('skips invalid, unsupported-trigger, reserved and duplicate rules while valid rules still run', () => {
    rules([
      'version: 1',
      'rules:',
      '  - id: no-template',
      '    on: session_start',
      '  - id: first-edit',
      '    on: first_edit',
      '    template: x',
      rule('handoff', 'mine'),
      rule('twice', 'one'),
      rule('twice', 'two'),
      '  - id: bad target',
      '    on: session_start',
      '    target: nobody',
      '    template: x',
      rule('kept', 'Kept rule'),
    ].join('\n'));
    const context = buildSessionContext(input());
    expect(byId(context, 'no-template')).toMatchObject({ status: 'skipped', reason: expect.stringContaining('template') });
    expect(byId(context, 'first-edit')).toMatchObject({ status: 'skipped', reason: expect.stringContaining('on must be session_start') });
    expect(context.reports.filter((report) => report.id === 'handoff').map((report) => report.status)).toEqual(['applied', 'skipped']);
    expect(context.reports.filter((report) => report.id === 'twice')).toHaveLength(2);
    expect(context.reports.filter((report) => report.id === 'twice').every((report) => report.reason === 'duplicate id')).toBe(true);
    expect(byId(context, 'rules[5]')).toMatchObject({ status: 'skipped' });
    expect(byId(context, 'kept')?.status).toBe('applied');
    expect(context.prefix).toContain('Kept rule');
    expect(context.prefix).not.toContain('mine');
  });

  it('renders only rules targeted at the recipient; target defaults to both', () => {
    rules([
      'version: 1',
      'rules:',
      rule('for-parent', 'P', 'parent'),
      rule('for-worker', 'W', 'worker'),
      '  - id: for-all',
      '    on: session_start',
      '    template: A',
    ].join('\n'));
    const parent = buildSessionContext(input());
    const worker = buildSessionContext(input({ role: 'worker' }));
    expect(parent.reports.map((report) => report.id)).toEqual(['handoff', 'for-parent', 'for-all']);
    expect(worker.reports.map((report) => report.id)).toEqual(['handoff', 'for-worker', 'for-all']);
  });
});

describe('session context: templates', () => {
  it('expands every documented variable', () => {
    const names = ['task', 'run.id', 'role', 'workflow.name', 'step.id', 'project.root', 'worktree.root', 'handoff.path'];
    rules(`version: 1\nrules:\n${rule('vars', names.map((name) => `${name}={{ ${name} }}`).join('\n'))}`);
    const prefix = buildSessionContext(input()).prefix;
    expect(prefix).toContain(`task=Fix the bug\nrun.id=run-1\nrole=parent\nworkflow.name=quick-task\nstep.id=task\nproject.root=${project}\nworktree.root=${worktree}\nhandoff.path=${handoff}`);
  });

  it('skips a rule with an unknown or unavailable variable, without guessing', () => {
    rules(`version: 1\nrules:\n${rule('unknown', '{{branch}}')}${rule('absent', '{{step.id}}')}`);
    const context = buildSessionContext(input({ variables: { task: 't' } }));
    expect(byId(context, 'unknown')).toMatchObject({ status: 'skipped', reason: 'unknown variable {{branch}}' });
    expect(byId(context, 'absent')).toMatchObject({ status: 'skipped', reason: 'variable {{step.id}} is not available for this launch' });
  });

  it('keeps tokens inside variable values and file contents literal', () => {
    writeFileSync(join(worktree, 'notes.txt'), 'see {{task}} and {{file:secret.txt}}');
    writeFileSync(join(worktree, 'secret.txt'), 'SECRET');
    rules(`version: 1\nrules:\n${rule('literal', '{{task}}|{{file:notes.txt}}')}`);
    const prefix = buildSessionContext(input({ variables: { task: 'run {{run.id}}' } })).prefix;
    expect(prefix).toContain('run {{run.id}}|see {{task}} and {{file:secret.txt}}');
    expect(prefix).not.toContain('SECRET');
  });

  it('reads included files from the recipient worktree, fresh each launch', () => {
    mkdirSync(join(worktree, 'docs'));
    writeFileSync(join(worktree, 'docs/vision.md'), 'Vision v1');
    rules(`version: 1\nrules:\n${rule('vision', 'Project vision:\n{{file:docs/vision.md}}')}`);
    expect(buildSessionContext(input()).prefix).toContain('Project vision:\nVision v1');
    writeFileSync(join(worktree, 'docs/vision.md'), 'Vision v2');
    const context = buildSessionContext(input());
    expect(context.prefix).toContain('Vision v2');
    expect(byId(context, 'vision')).toMatchObject({ status: 'applied', sources: ['docs/vision.md'] });
  });

  it('refuses absolute paths, escaping paths and escaping symlinks', () => {
    writeFileSync(join(root, 'outside.txt'), 'OUTSIDE');
    symlinkSync(join(root, 'outside.txt'), join(worktree, 'link.txt'));
    writeFileSync(join(worktree, 'inside.txt'), 'INSIDE');
    symlinkSync(join(worktree, 'inside.txt'), join(worktree, 'inside-link.txt'));
    rules(`version: 1\nrules:\n${[
      rule('absolute', `{{file:${join(root, 'outside.txt')}}}`),
      rule('dotdot', '{{file:../outside.txt}}'),
      rule('symlink', '{{file:link.txt}}'),
      rule('inner-link', '{{file:inside-link.txt}}'),
    ].join('')}`);
    const context = buildSessionContext(input());
    expect(byId(context, 'absolute')).toMatchObject({ status: 'skipped', reason: expect.stringContaining('absolute paths are not allowed') });
    expect(byId(context, 'dotdot')).toMatchObject({ status: 'skipped', reason: expect.stringContaining('outside the worktree') });
    expect(byId(context, 'symlink')).toMatchObject({ status: 'skipped', reason: expect.stringContaining('outside the worktree') });
    expect(byId(context, 'inner-link')?.status).toBe('applied');
    expect(context.prefix).not.toContain('OUTSIDE');
  });

  it('skips missing and unreadable files with the path in the report', () => {
    writeFileSync(join(worktree, 'locked.txt'), 'locked');
    chmodSync(join(worktree, 'locked.txt'), 0o000);
    rules(`version: 1\nrules:\n${rule('missing', '{{file:nope.md}}')}${rule('locked', '{{file:locked.txt}}')}${rule('dir', '{{file:.}}')}`);
    const context = buildSessionContext(input());
    expect(byId(context, 'missing')).toMatchObject({ status: 'skipped', sources: ['nope.md'], reason: 'file nope.md: not found' });
    // Root can read a mode-000 file; the rule then applies, which is still not a crash.
    if (process.getuid?.() !== 0) expect(byId(context, 'locked')).toMatchObject({ status: 'skipped', reason: expect.stringContaining('unreadable') });
    expect(byId(context, 'dir')).toMatchObject({ status: 'skipped', reason: expect.stringContaining('outside the worktree') });
  });
});

describe('session context: report line', () => {
  it('names each block, its size, sources and reason, and never its contents', () => {
    writeFileSync(join(worktree, 'vision.md'), 'TOP-SECRET-VISION');
    rules(`version: 1\nrules:\n${rule('vision', '{{file:vision.md}}')}${rule('gone', '{{file:gone.md}}')}`);
    const line = formatSessionContextReport(buildSessionContext(input()).reports);
    expect(line).toMatch(new RegExp(`^session context: handoff applied \\(\\d+ B, ${handoff.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\); vision applied \\(\\d+ B, vision\\.md\\); gone skipped \\(gone\\.md\\) — file gone\\.md: not found$`));
    expect(line).not.toContain('TOP-SECRET-VISION');
  });
});
