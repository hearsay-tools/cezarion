import { describe, expect, it } from 'vitest';
import type { Skill } from './skills.ts';
import { MAX_SKILL_CLOSURE, mentionsSkill, skillClosure } from './skills-provision.ts';

function skill(name: string, body = '', source: Skill['source'] = 'ai'): Skill {
  return { name, body, path: `/skills/${name}/SKILL.md`, source };
}

describe('mentionsSkill', () => {
  it('matches a hyphenated name as a whole word', () => {
    expect(mentionsSkill('run om-code-review now', 'om-code-review')).toBe(true);
    expect(mentionsSkill('run om-code-reviewer now', 'om-code-review')).toBe(false);
    expect(mentionsSkill('see x-om-code-review', 'om-code-review')).toBe(false);
  });

  it('matches a plain name only as /name or `name`', () => {
    expect(mentionsSkill('then run /fix on it', 'fix')).toBe(true);
    expect(mentionsSkill('then run `fix` on it', 'fix')).toBe(true);
    expect(mentionsSkill('fix the bug', 'fix')).toBe(false);
  });
});

describe('skillClosure', () => {
  it('lists the roots first, then every skill they name, transitively', () => {
    const a = skill('lead-a', 'then run helper-b');
    const b = skill('helper-b', 'finish with helper-c');
    const c = skill('helper-c');
    const unrelated = skill('other-d');
    expect(skillClosure([a], [unrelated, c, b, a]).skills.map((s) => s.name)).toEqual(['lead-a', 'helper-b', 'helper-c']);
  });

  it('stops on a cycle', () => {
    const a = skill('lead-a', 'run helper-b');
    const b = skill('helper-b', 'back to lead-a');
    expect(skillClosure([a], [a, b]).skills.map((s) => s.name)).toEqual(['lead-a', 'helper-b']);
  });

  it('takes the first catalog entry for a name, so local skills win', () => {
    const local = skill('helper-b', 'LOCAL', 'ai');
    const team = skill('helper-b', 'TEAM', 'team');
    const [, found] = skillClosure([skill('lead-a', 'run helper-b')], [local, team]).skills;
    expect(found?.body).toBe('LOCAL');
  });

  it('caps the closure and names the first skill it left out', () => {
    const chain = Array.from({ length: 30 }, (_, i) => skill(`step-${i}`, i < 29 ? `next step-${i + 1}` : ''));
    const result = skillClosure([chain[0]!], chain);
    expect(MAX_SKILL_CLOSURE).toBe(24);
    expect(result.skills).toHaveLength(24);
    expect(result.truncated).toBe('step-24');
  });

  it('reports no truncation when the closure fits', () => {
    expect(skillClosure([skill('lead-a')], []).truncated).toBeUndefined();
  });
});
