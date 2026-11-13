import { z } from 'zod';

// ---- team skill sources (`/skills/sources`, hearsay-tools/cezarion#279) -------------------------

/** The source shapes Squawk accepts, as the cockpit and every refusal name them. */
export const SKILLS_REPO_FORMATS = 'owner/name, an https, ssh or git URL, git@host:path, or a local or file:// path';

const ALLOWED_URL_SCHEMES = new Set(['https', 'http', 'ssh', 'git', 'file']);

/**
 * The kind of a `skillsRepos` `repo` value, or null when Squawk refuses it. One rule for the
 * request schema, the cockpit's Add form and the server's git remote (`safeRemoteFor`).
 *
 * Refused: an empty value, a leading `-` (git would read an option), `::` (remote-helper
 * transports run commands) and URL schemes outside https, http, ssh, git and file. Local paths
 * are matched before the `owner/name` shorthand, because `./rel` fits the shorthand charset.
 */
export function skillsRepoKind(repo: string): 'home' | 'local' | 'github' | 'url' | 'scp' | null {
  const value = repo.trim();
  if (!value || value.startsWith('-') || value.includes('::')) return null;
  if (value.startsWith('~/')) return 'home';
  if (/^(\/|\.\/|\.\.\/)/.test(value)) return 'local';
  // Windows drive-letter path (`C:\repo`, `C:/repo`): win32 is a supported platform.
  if (/^[A-Za-z]:[\\/]/.test(value)) return 'local';
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return 'github';
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  if (scheme) return ALLOWED_URL_SCHEMES.has(scheme[1]!.toLowerCase()) ? 'url' : null;
  if (/^[\w.-]+@[\w.-]+:/.test(value)) return 'scp';
  return null;
}

/**
 * A ref safe to pass to `git` as a positional revision (hearsay-tools/cezarion#428): a branch, tag or commit SHA. It
 * refuses a leading `-`, `..` and anything outside the git ref-name charset.
 */
export function isSafeSkillsRef(ref: string): boolean {
  return ref.length > 0 && ref.length <= 256 && !ref.startsWith('-') && !ref.includes('..') && /^[A-Za-z0-9._/-]+$/.test(ref);
}

const repoField = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((repo) => skillsRepoKind(repo) !== null, { message: `Use ${SKILLS_REPO_FORMATS}.` });
const refField = z
  .string()
  .trim()
  .refine(isSafeSkillsRef, { message: 'Use a branch, tag or commit SHA, such as main.' });

/**
 * One configured source by its identity, exactly as `skillsRepos` spells it. Two refs of one repo
 * are two sources. Not shape-checked: a source in a refused format must still be removable.
 */
export const teamSkillSourceRefSchema = z.object({ repo: z.string().min(1).max(500), ref: z.string().min(1).max(256) }).strict();
export type TeamSkillSourceRef = z.infer<typeof teamSkillSourceRefSchema>;

/** `POST /skills/sources`: the ref defaults to `main`, as in `skillsRepos`. */
export const addTeamSkillSourceSchema = z.object({ repo: repoField, ref: refField.optional() }).strict();
export type AddTeamSkillSource = z.infer<typeof addTeamSkillSourceSchema>;

/** `PATCH /skills/sources`. */
export const setTeamSkillSourceEnabledSchema = teamSkillSourceRefSchema.extend({ enabled: z.boolean() }).strict();
export type SetTeamSkillSourceEnabled = z.infer<typeof setTeamSkillSourceEnabledSchema>;

/** Why a source has no fresh skill list. */
export const TEAM_SOURCE_FAILURE_CAUSES = ['refused-format', 'fetch-failed', 'ref-not-found'] as const;
export const teamSourceFailureCauseSchema = z.enum(TEAM_SOURCE_FAILURE_CAUSES);
export type TeamSourceFailureCause = z.infer<typeof teamSourceFailureCauseSchema>;

/**
 * One source's state. `idle` is a disabled source, or one no load has reached yet. A failed
 * source keeps the skills an older clone still lists, so `skillCount` can be above 0.
 */
export const teamSourceStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('idle') }),
  z.object({ state: z.literal('loading') }),
  z.object({ state: z.literal('ok'), skillCount: z.number().int().min(0) }),
  z.object({
    state: z.literal('error'),
    cause: teamSourceFailureCauseSchema,
    detail: z.string(),
    skillCount: z.number().int().min(0),
  }),
]);
export type TeamSourceStatus = z.infer<typeof teamSourceStatusSchema>;

/** A `skillsRepos` entry as the Skills page shows it. `repo` is kept exactly as configured. */
export const teamSkillSourceSchema = z.object({
  repo: z.string(),
  ref: z.string(),
  enabled: z.boolean(),
  status: teamSourceStatusSchema,
});
export type TeamSkillSource = z.infer<typeof teamSkillSourceSchema>;

/**
 * `GET /skills/sources` and every write's answer. `editable` is false on a cockpit whose
 * settings are admin-only. `configIssue` names why `.ai/cezar/config.json` cannot be read; while
 * it is set, every write is refused and `sources` is empty.
 */
export const teamSkillSourcesResponseSchema = z.object({
  sources: z.array(teamSkillSourceSchema),
  editable: z.boolean(),
  configIssue: z.string().nullable(),
});
export type TeamSkillSourcesResponse = z.infer<typeof teamSkillSourcesResponseSchema>;
