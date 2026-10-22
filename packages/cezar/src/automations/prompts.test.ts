import { describe, expect, it } from 'vitest';
import { createAutomationInputSchema } from '@open-mercato/cezar-contract/automations';
import { SCHEDULE_HOURS_OPTIONS, SCHEDULE_TYPES } from '@open-mercato/cezar-contract/automation-schedule';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { GITHUB_PLACEHOLDERS, SCHEDULE_PLACEHOLDERS } from './task-template.ts';
import { automationDefinitionObjectSchema, automationEventSchema, automationFiltersSchema, automationTaskSchema } from './types.ts';
import {
  AUTOMATION_SCHEMA_REFERENCE,
  CREATE_AUTOMATION_SKILL_NAME,
  automationCliCommand,
  automationsPrompt,
  createAutomationSkillBody,
} from './prompts.ts';

/** The storage schema is the source of truth: the reference an agent reads must not drift from it. */
const objectKeys = (schema: unknown): string[] => {
  let current = schema as { shape?: Record<string, unknown>; _def?: { schema?: unknown; innerType?: unknown } };
  while (!current.shape && current._def) current = (current._def.schema ?? current._def.innerType) as typeof current;
  return Object.keys(current.shape ?? {});
};

// `archived` is written by the server when a one-time schedule's task exists or it is cancelled.
const SERVER_OWNED = new Set(['id', 'revision', 'enabled', 'createdAt', 'updatedAt', 'archived']);

describe('AUTOMATION_SCHEMA_REFERENCE', () => {
  it('names every definition key a caller may send', () => {
    const keys = objectKeys(automationDefinitionObjectSchema).filter((key) => !SERVER_OWNED.has(key));
    expect(keys.length).toBeGreaterThan(5);
    for (const key of keys) expect(AUTOMATION_SCHEMA_REFERENCE, key).toContain(`"${key}"`);
  });

  it('names every task and filter key, event, schedule type and runner', () => {
    for (const key of objectKeys(automationTaskSchema)) expect(AUTOMATION_SCHEMA_REFERENCE, key).toContain(`"${key}"`);
    for (const key of objectKeys(automationFiltersSchema)) expect(AUTOMATION_SCHEMA_REFERENCE, key).toContain(`"${key}"`);
    for (const event of automationEventSchema.options) expect(AUTOMATION_SCHEMA_REFERENCE).toContain(event);
    for (const type of SCHEDULE_TYPES) expect(AUTOMATION_SCHEMA_REFERENCE).toContain(`"${type}"`);
    for (const every of SCHEDULE_HOURS_OPTIONS) expect(AUTOMATION_SCHEMA_REFERENCE).toContain(String(every));
    for (const runner of RUNNER_IDS) expect(AUTOMATION_SCHEMA_REFERENCE).toContain(runner);
  });

  it('states the storage bounds', () => {
    for (const bound of ['60-86400', '1-90', '1-100', '1-200', '1-4']) expect(AUTOMATION_SCHEMA_REFERENCE).toContain(bound);
  });

  it('lists exactly the placeholders the template renderer accepts', () => {
    const named = new Set([...AUTOMATION_SCHEMA_REFERENCE.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1]!));
    named.delete('task'); // the workflow step token in the inline-steps example, not an automation placeholder
    expect([...named].sort()).toEqual([...GITHUB_PLACEHOLDERS, ...SCHEDULE_PLACEHOLDERS].sort());
  });

  // Review of #1018: agents copy these examples into `--json`/`--file`, so each must be a valid
  // definition as written, with no comments inside it.
  it('prints examples that parse as JSON and that the create route accepts', () => {
    const blocks = [...AUTOMATION_SCHEMA_REFERENCE.matchAll(/^\{\n[\s\S]*?^\}$/gm)].map((match) => match[0]);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      const parsed = JSON.parse(block) as unknown;
      const created = createAutomationInputSchema.safeParse(parsed);
      expect(created.success, JSON.stringify(created.error?.issues)).toBe(true);
    }
  });

  it('describes no dispatch: the fork delegates through governed workers', () => {
    expect(AUTOMATION_SCHEMA_REFERENCE).not.toMatch(/dispatch/i);
  });
});

describe('automationsPrompt and the skill body', () => {
  const command = "'/usr/bin/node' '/opt/cezar/dist/index.js' automation";

  it('addresses the CLI by the command it is given, never a bare cez on PATH', () => {
    for (const text of [automationsPrompt(command), createAutomationSkillBody(command)]) {
      expect(text).toContain(command);
      const withoutCommand = text.replaceAll(command, '<CLI>');
      expect(withoutCommand).not.toMatch(/(^|[\s`"'(])(cez|cezar|cezarion) automation /m);
    }
  });

  it('never tells an agent to start a cockpit', () => {
    for (const text of [automationsPrompt(command), createAutomationSkillBody(command), AUTOMATION_SCHEMA_REFERENCE]) {
      expect(text).not.toMatch(/start (the|a) cockpit|run `?cez`?\b|\bcez serve\b/i);
    }
  });

  it('tells the agent to stop and report when the CLI is refused, not to substitute a cron job', () => {
    expect(automationsPrompt(command)).toMatch(/stop and report that automations are unavailable/);
    expect(automationsPrompt(command)).toMatch(/cron job/);
  });

  it('keeps the automation paused under an autonomy nudge: only the user\'s request enables it', () => {
    for (const text of [automationsPrompt(command), createAutomationSkillBody(command)]) {
      expect(text).toContain('A paused automation is the finished state of this task');
      expect(text).toMatch(/continue autonomously, not to ask for confirmation, or to make reasonable assumptions is not that request/);
    }
  });

  it('embeds the full reference in the skill body', () => {
    expect(createAutomationSkillBody(command)).toContain(AUTOMATION_SCHEMA_REFERENCE);
    expect(CREATE_AUTOMATION_SKILL_NAME).toBe('create-cezarion-automation');
  });

  it('builds the CLI command from this process, quoted for a POSIX shell', () => {
    const cli = automationCliCommand();
    expect(cli.startsWith(`'${process.execPath}'`)).toBe(true);
    expect(cli.endsWith(' automation')).toBe(true);
  });
});
