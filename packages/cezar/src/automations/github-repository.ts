import { forgeKindOfRemote, parseRemote } from '../server/forge/index.ts';
import { forgetRepoHandle, resolveRepoHandle } from '../server/forge/github-repo-handle.ts';

export interface GithubRepositoryName { owner: string; repo: string }

/**
 * The repository a project's GitHub polls read. `owner`/`repo` come from the `origin` URL text,
 * which keeps the old name after a rename; GitHub search answers an old `repo:` qualifier with
 * HTTP 422 and some lists with nothing (hearsay-tools/cezarion#3326). `canonical` asks GitHub for
 * the current name and `forget` drops the cached answer.
 */
export interface GithubRepository extends GithubRepositoryName {
  canonical?: () => Promise<GithubRepositoryName>;
  forget?: () => void;
}

/** The project's GitHub repository, or undefined when `origin` is not on github.com. */
export function githubRepository(
  root: string,
  remote: string | undefined,
  resolve: typeof resolveRepoHandle = resolveRepoHandle,
  forget: typeof forgetRepoHandle = forgetRepoHandle,
): GithubRepository | undefined {
  const parsed = parseRemote(remote ?? '');
  if (!parsed || forgeKindOfRemote(remote) !== 'github') return undefined;
  const fallback = { owner: parsed.owner, repo: parsed.repo };
  return {
    ...fallback,
    canonical: async () => {
      const handle = await resolve(root);
      return handle ? { owner: handle.owner, repo: handle.name } : fallback;
    },
    forget: () => forget(root),
  };
}

/** A GitHub answer that can mean the name is no longer the repository's. */
export function isRepositoryNameMiss(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';
  return /HTTP 404|HTTP 422|Not Found|Validation Failed/i.test(`${error.message}\n${stderr}`);
}

/**
 * Runs `read` under the repository's canonical name. When GitHub refuses that name, asks for the
 * name again and, only if it changed, runs `read` once more under the new one.
 */
export async function readUnderCanonicalName<T>(
  repository: GithubRepository,
  read: (name: GithubRepositoryName) => Promise<T>,
): Promise<T> {
  const first = await nameOf(repository);
  try {
    return await read(first);
  } catch (error) {
    if (!repository.canonical || !repository.forget || !isRepositoryNameMiss(error)) throw error;
    repository.forget();
    const next = await nameOf(repository);
    if (sameName(next, first)) throw error;
    return await read(next);
  }
}

async function nameOf(repository: GithubRepository): Promise<GithubRepositoryName> {
  return repository.canonical ? await repository.canonical() : { owner: repository.owner, repo: repository.repo };
}

function sameName(a: GithubRepositoryName, b: GithubRepositoryName): boolean {
  return `${a.owner}/${a.repo}`.toLowerCase() === `${b.owner}/${b.repo}`.toLowerCase();
}
