import { z } from 'zod';
import { githubProjectSchema, type GithubProject } from '@open-mercato/cezar-contract/github';
import type { GraphqlRunner } from './github.ts';

const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const projectsSchema = z.object({
  data: z.object({ repository: z.object({ projectsV2: z.object({
    nodes: z.array(githubProjectSchema.nullable()), pageInfo: pageInfoSchema,
  }) }) }),
});
const membershipSchema = z.object({ data: z.object({ repository: z.record(z.string(), z.object({
  projectItems: z.object({
    nodes: z.array(z.object({ project: z.object({ id: z.string() }) }).nullable()),
    pageInfo: pageInfoSchema,
  }),
})) }) });
const viewerSchema = z.object({ data: z.object({ viewer: z.object({ login: z.string().min(1) }) }) });

const graphqlErrorsSchema = z.object({ errors: z.array(z.object({ message: z.string() })).optional() });

function assertGraphqlSuccess(raw: unknown): void {
  const errors = graphqlErrorsSchema.parse(raw).errors;
  if (errors?.length) throw new Error(errors.map(error => error.message).join(' '));
}

/** Classify provider errors without echoing subprocess commands or arbitrary stderr. */
function projectFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/rate.?limit|HTTP 429|Too Many Requests|abuse detection/i.test(message)) {
    return 'GitHub is rate-limiting project board requests. Wait a few minutes, then refresh.';
  }
  if (/read:project|INSUFFICIENT_SCOPES/i.test(message)) {
    return 'GitHub project read access is missing. Run gh auth refresh -s read:project, then refresh. If cezar uses GH_TOKEN or GITHUB_TOKEN, grant that token project read access instead.';
  }
  if (/resource not accessible|forbidden|HTTP 403/i.test(message)) {
    return 'GitHub credentials cannot access project boards. Grant project read access to the account or token used by cezar, then refresh.';
  }
  if (/timed out|ETIMEDOUT/i.test(message) || (error instanceof Error && 'killed' in error && error.killed === true)) {
    return 'Project board lookup timed out. Refresh to try again.';
  }
  if (error instanceof z.ZodError || /Incomplete project|page limit|cursor did not advance/i.test(message)) {
    return 'Project board data is incomplete. Refresh to try again.';
  }
  return 'Project boards unavailable. Refresh to try again.';
}

/** Viewer is independent of Projects permissions, and cached with the list. */
export async function fetchViewerLogin(run: GraphqlRunner): Promise<string | undefined> {
  try {
    return viewerSchema.parse(JSON.parse(await run('query { viewer { login } }', {}))).data.viewer.login;
  } catch { return undefined; }
}

type ProjectResult =
  | { projects: GithubProject[]; membership: Record<number, string[]> }
  | { projectsReason: string };

/** The boards linked to a repository. Throws on any failure; the caller classifies it. */
export async function fetchRepositoryProjects(run: GraphqlRunner, owner: string, name: string): Promise<GithubProject[]> {
  const projects = new Map<string, GithubProject>();
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= 10) throw new Error('Project discovery exceeded its page limit');
    const raw = JSON.parse(await run(`query($owner:String!,$name:String!,$cursor:String) {
      repository(owner:$owner,name:$name) { projectsV2(first:100,after:$cursor) {
        nodes { id title url } pageInfo { hasNextPage endCursor }
      } }
    }`, { owner, name, ...(cursor ? { cursor } : {}) }));
    assertGraphqlSuccess(raw);
    const connection = projectsSchema.parse(raw).data.repository.projectsV2;
    for (const board of connection.nodes) if (board) projects.set(board.id, board);
    if (!connection.pageInfo.hasNextPage) break;
    const next = connection.pageInfo.endCursor;
    if (!next || next === cursor) throw new Error('Project discovery cursor did not advance');
    cursor = next;
  }
  return [...projects.values()];
}

/** Which of `projects` each issue in `numbers` belongs to. Throws on any failure or on an
 *  incomplete membership page. */
export async function fetchProjectMembership(
  run: GraphqlRunner, owner: string, name: string, projects: readonly GithubProject[], numbers: readonly number[],
): Promise<Record<number, string[]>> {
  const known = new Set(projects.map(project => project.id));
  const membership: Record<number, string[]> = {};
  if (known.size === 0) return membership;
  const ids = [...new Set(numbers)];
  if (ids.length > 1000 || ids.some(n => !Number.isSafeInteger(n) || n <= 0)) {
    throw new Error('Invalid issue window');
  }
  for (let offset = 0; offset < ids.length; offset += 100) {
    // The aliases and literals contain validated integers only; all external strings are variables.
    const batch = ids.slice(offset, offset + 100);
    const fields = batch.map(n => `i${n}: issue(number:${n}) {
      projectItems(first:100,includeArchived:true) {
        nodes { project { id } } pageInfo { hasNextPage endCursor }
      }
    }`).join('\n');
    const raw = JSON.parse(await run(`query($owner:String!,$name:String!) {
      repository(owner:$owner,name:$name) { ${fields} }
    }`, { owner, name }));
    assertGraphqlSuccess(raw);
    const rows = membershipSchema.parse(raw).data.repository;
    for (const n of batch) {
      const connection = rows[`i${n}`]?.projectItems;
      if (!connection || connection.pageInfo.hasNextPage) throw new Error('Incomplete project memberships');
      membership[n] = [...new Set(connection.nodes.flatMap(row =>
        row && known.has(row.project.id) ? [row.project.id] : [],
      ))];
    }
  }
  return membership;
}

/** Discover only repository-linked boards, then memberships for exactly the loaded issues.
 * Pagination has both page and caller-owned time bounds. Incomplete metadata disables this
 * optional filter rather than falsely claiming that some issues do not belong to a board.
 * `discover` lets a caller share one discovery across list pages (hearsay-tools/cezarion#1183).
 */
export async function fetchIssueProjects(
  run: GraphqlRunner, owner: string, name: string, numbers: readonly number[] | (() => Promise<readonly number[]>),
  discover: () => Promise<GithubProject[]> = () => fetchRepositoryProjects(run, owner, name),
): Promise<ProjectResult> {
  try {
    const projects = await discover();
    if (projects.length === 0) return { projects: [], membership: {} };
    const ids = typeof numbers === 'function' ? await numbers() : numbers;
    return { projects, membership: await fetchProjectMembership(run, owner, name, projects, ids) };
  } catch (error) {
    return { projectsReason: projectFailureReason(error) };
  }
}
