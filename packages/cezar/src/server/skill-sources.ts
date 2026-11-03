import type {
  AddTeamSkillSource,
  SetTeamSkillSourceEnabled,
  TeamSkillSource,
  TeamSkillSourceRef,
  TeamSkillSourcesResponse,
} from '@open-mercato/cezar-contract/skill-sources';
import { readRawConfig, updateConfigFile, type RawConfigRead } from '../config.ts';
import { getTeamSourceStatuses, refreshTeamSources, reloadTeamSkills, sourceKey } from '../skills-remote.ts';

/**
 * Team skill sources on the Skills page (hearsay-tools/cezarion#279). Every change edits only
 * `skillsRepos` in the project's `.ai/cezar/config.json`, through `updateConfigFile`; other keys
 * stay as they are. A file that cannot be read is never written.
 */

/** Settings are admin-only on this cockpit: the source controls are read-only. */
export const SKILL_SOURCES_HOSTED_ERROR =
  'Team skill sources are read-only on this remote cockpit. To allow remote edits, run `cez remote-settings enable` on the machine running cezar.';

export interface SkillSourcesProject {
  root: string;
  dataDir: string;
}

type Refusal = { ok: false; status: 404 | 409; error: string };
export type SkillSourcesAnswer = { ok: true; body: TeamSkillSourcesResponse } | Refusal;

/** A `skillsRepos` entry as the file spells it. Entries the schema accepted are objects. */
interface RawSource {
  repo: string;
  ref?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

function rawSources(raw: Record<string, unknown>): RawSource[] {
  return Array.isArray(raw.skillsRepos) ? (raw.skillsRepos as RawSource[]) : [];
}

const refOf = (entry: RawSource): TeamSkillSourceRef => ({ repo: entry.repo, ref: entry.ref ?? 'main' });
const sameSource = (entry: RawSource, ref: TeamSkillSourceRef) => sourceKey(refOf(entry)) === sourceKey(ref);

/** The page's view: each source, with the state its last load left. */
export async function readSkillSources(project: SkillSourcesProject, editable: boolean): Promise<TeamSkillSourcesResponse> {
  return answerFor(project.root, await readRawConfig(project.dataDir), editable);
}

function answerFor(root: string, read: RawConfigRead, editable: boolean): TeamSkillSourcesResponse {
  if (!read.ok) return { sources: [], editable, configIssue: read.issue };
  const statuses = getTeamSourceStatuses(root);
  const sources: TeamSkillSource[] = rawSources(read.raw).map((entry) => {
    const ref = refOf(entry);
    const enabled = entry.enabled !== false;
    return { ...ref, enabled, status: (enabled && statuses.get(sourceKey(ref))) || { state: 'idle' } };
  });
  return { sources, editable, configIssue: null };
}

type SourcesChange = (sources: RawSource[]) => { next: RawSource[] } | { status: 404 | 409; error: string };

/**
 * Apply one change to `skillsRepos` under the config lock. Refused, in order: an admin-only
 * cockpit, an unreadable file, then whatever `change` refuses. Nothing is written on a refusal.
 */
async function changeSources(
  project: SkillSourcesProject,
  editable: boolean,
  change: SourcesChange,
): Promise<{ ok: true } | Refusal> {
  if (!editable) return { ok: false, status: 409, error: SKILL_SOURCES_HOSTED_ERROR };
  return updateConfigFile<{ ok: true } | Refusal>(project.dataDir, (current) => {
    if (!current.ok) return { refuse: { ok: false, status: 409, error: current.issue } };
    const outcome = change(rawSources(current.raw));
    if ('error' in outcome) return { refuse: { ok: false, ...outcome } };
    return { write: { ...current.raw, skillsRepos: outcome.next }, result: { ok: true } };
  });
}

async function settle(
  project: SkillSourcesProject,
  editable: boolean,
  outcome: { ok: true } | Refusal,
  after: () => unknown,
): Promise<SkillSourcesAnswer> {
  if (!outcome.ok) return outcome;
  await after();
  return { ok: true, body: await readSkillSources(project, editable) };
}

/**
 * Add a source, enabled, at the end of the list, then fetch it in the background: the answer
 * shows it loading, and the page reads its skills or its error when the fetch ends. A source
 * added with no ref is written without one, as a hand-written entry would be.
 */
export async function addSkillSource(project: SkillSourcesProject, editable: boolean, body: AddTeamSkillSource): Promise<SkillSourcesAnswer> {
  const ref = { repo: body.repo, ref: body.ref ?? 'main' };
  const outcome = await changeSources(project, editable, (sources) =>
    sources.some((entry) => sameSource(entry, ref))
      ? { status: 409, error: `${ref.repo} at ${ref.ref} is already listed.` }
      : { next: [...sources, body.ref === undefined ? { repo: ref.repo } : ref] });
  return settle(project, editable, outcome, () => {
    void refreshTeamSources(project.root, [ref]);
  });
}

/** Enable or disable a source. Its per-skill switches stay as they are either way. */
export async function setSkillSourceEnabled(
  project: SkillSourcesProject,
  editable: boolean,
  body: SetTeamSkillSourceEnabled,
): Promise<SkillSourcesAnswer> {
  const outcome = await changeSources(project, editable, (sources) => {
    if (!sources.some((entry) => sameSource(entry, body))) return notListed(body);
    return { next: sources.map((entry) => (sameSource(entry, body) ? withEnabled(entry, body.enabled) : entry)) };
  });
  return settle(project, editable, outcome, () => reloadTeamSkills(project.root));
}

/** Enabled is the default, so an enabled entry carries no `enabled` key, as before #279. */
function withEnabled(entry: RawSource, enabled: boolean): RawSource {
  const { enabled: _previous, ...rest } = entry;
  return enabled ? (rest as RawSource) : { ...rest, enabled: false };
}

/** Remove a source. Its per-skill switches stay in `ui-state.json`, so adding it again restores them. */
export async function removeSkillSource(project: SkillSourcesProject, editable: boolean, body: TeamSkillSourceRef): Promise<SkillSourcesAnswer> {
  const outcome = await changeSources(project, editable, (sources) =>
    sources.some((entry) => sameSource(entry, body))
      ? { next: sources.filter((entry) => !sameSource(entry, body)) }
      : notListed(body));
  return settle(project, editable, outcome, () => reloadTeamSkills(project.root));
}

/** Fetch one enabled source again, in the background, as the page's Retry. */
export async function retrySkillSource(project: SkillSourcesProject, editable: boolean, body: TeamSkillSourceRef): Promise<SkillSourcesAnswer> {
  const read = await readRawConfig(project.dataDir);
  if (!read.ok) return { ok: false, status: 409, error: read.issue };
  const entry = rawSources(read.raw).find((candidate) => sameSource(candidate, body));
  if (!entry || entry.enabled === false) return { ok: false, ...notListed(body) };
  void refreshTeamSources(project.root, [body]);
  return { ok: true, body: answerFor(project.root, read, editable) };
}

function notListed(ref: TeamSkillSourceRef): { status: 404; error: string } {
  return { status: 404, error: `${ref.repo} at ${ref.ref} is not a listed team skill source.` };
}
