/**
 * Built-in automation playbook as a TypeScript constant. Offer only when the feature is enabled
 * and the manager has a cockpit address; headless runs must not advertise an unavailable
 * service.
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
