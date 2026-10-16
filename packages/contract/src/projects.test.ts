import { describe, expect, it } from 'vitest';
import { createProjectInputSchema } from './projects.ts';

/** The create body's name must be exactly what the route accepts (spec 2026-10-15-create-new-project):
 *  GitHub's repository-name characters, starting with a letter or digit like every checkout folder. */
describe('createProjectInputSchema name', () => {
  it('accepts names GitHub and the checkout root both take', () => {
    for (const name of ['app', '9lives', 'a.b-c_d', 'x'.repeat(100)]) {
      expect(createProjectInputSchema.safeParse({ name }).success, name).toBe(true);
    }
  });

  it('refuses what the route would refuse — never a name the middleware lets through for the handler to reject', () => {
    for (const name of ['-dash', '.hidden', '_under', '.', '..', 'my project', 'a/b', 'x'.repeat(101)]) {
      expect(createProjectInputSchema.safeParse({ name }).success, name).toBe(false);
    }
  });
});
