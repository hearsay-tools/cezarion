import type { ActiveRun } from '../../../packages/cezar/src/workflows/active-run.ts';
import type { SkillsGroup } from '../../../packages/cezar/src/workflows/run/run-skills.ts';
declare const state: ActiveRun;
declare const other: ActiveRun;
// @ts-expect-error The migrated slot is read-only.
state.skills = other.skills;
const { catalog } = state.skills;
// @ts-expect-error The array cannot be mutated.
catalog!.push(catalog![0]!);
// @ts-expect-error Numeric array slots cannot be replaced.
catalog![0] = other.skills.catalog![0]!;
// @ts-expect-error Skill properties are getter-only.
catalog![0]!.body = 'forged';
// @ts-expect-error Nested team records are getter-only.
catalog![0]!.team!.repo = 'forged';
declare const group: Parameters<(group: SkillsGroup) => void>[0];
// @ts-expect-error A helper cannot replace the provisioning handle.
group.liveSkillProvisioning = Promise.resolve();
