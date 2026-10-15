/**
 * The built-in `create-cezarion-automation` skill (#774, port of upstream #985).
 *
 * cezar ships no skill files of its own; this is the one deliberate exception: the playbook for
 * turning a prompt into an automation belongs to the cockpit that runs automations, not to a
 * repository. A TypeScript constant rather than a Markdown file in the tarball, so the pack gate
 * and the discovery walk stay what they were.
 *
 * Gated by the caller (`RunManager.automationsReachable`): offered only when automations are on
 * AND a cockpit has handed the manager its address. A headless `cez run` or a cockpit without
 * `CEZ_AUTOMATIONS=1` would hand the agent a playbook whose every command is refused.
 */
import type { Skill } from '../skills.ts';
import { CREATE_AUTOMATION_SKILL_NAME, createAutomationSkillBody } from './prompts.ts';

export function createAutomationSkill(command: string): Skill {
  return {
    name: CREATE_AUTOMATION_SKILL_NAME,
    description:
      'Turn a request like "whenever a PR is opened, review it" or "every weekday at 7, sweep failed CI" into an automation on this cockpit: created paused, previewed, and linked.',
    // An automation is authored, not coded: nothing to isolate, and the agent may need to ask
    // which label or event the user meant.
    interactive: true,
    body: createAutomationSkillBody(command),
    path: `builtin:${CREATE_AUTOMATION_SKILL_NAME}`,
    source: 'builtin',
  };
}
