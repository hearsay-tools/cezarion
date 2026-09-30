import './repo-git.css'
import { GitBranchIcon, TriangleAlertIcon } from '@/components/design-icons'

import { useSearchParams } from 'react-router'

import { useRepo } from '@/api/queries'
import type { RepoInfo, RepoResponse } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { useIsDesktop } from '@/lib/use-desktop'

import { GitScreen } from './git-screen'
import { gitSectionLabel } from './git-section-list'
import { fetchedAgo, type GitSection } from './git-sections'
import { RepoBackLink } from './repo-back-link'
import { RepoBranchesSection } from './repo-branches'
import { RepoChangesSection } from './repo-changes'
import { RepoCommitsSection } from './repo-commits'
import { CleanupBranchesCard } from './repo-cleanup-branches'
import { RepoGitLoading } from './repo-git-loading'
import { RepoNotLandedSection } from './repo-not-landed'
import { WorktreesPanel } from './worktrees-panel'

/**
 * `/git…` — the Git view (issue 06 §3, #622): is the base my agents start from right, and what
 * came back into it? The sections live in the sidebar (desktop) or the phone's Git screen; the
 * main area shows the open one under a header with a title and a meta line, and no tabs:
 *
 * - Recently on main (`/git`, and the old `/git/commits[/:sha]`): the log grouped by day; a
 *   commit opens inside it.
 * - Not landed (`/git/not-landed`, issue 08): finished tasks whose commits are not on the base.
 * - Cleanup (`/git/cleanup`): the worktrees on disk (moved here from Settings) and the branches
 *   safe to delete.
 * - All branches (`/git/branches`): the branch list with switch/create.
 * - Uncommitted changes (`/git/changes`): the main tree's diff, reached from the checkout block.
 *
 * Every section is a URL, so each deep-links and survives a refresh.
 */
export function RepoGitRoute({ section, index = false }: {
  section: GitSection
  /** The bare `/git` route: a phone shows the Git screen there unless `?view=repo`. */
  index?: boolean
}) {
  const repo = useRepo()
  const isDesktop = useIsDesktop()
  const [params] = useSearchParams()

  // A phone's bare /git is the Git screen; Recently on main is `?view=repo`. Every other section
  // and deep link keeps its URL, and desktop never shows the screen.
  if (index && !isDesktop && params.get('view') !== 'repo') {
    return <GitScreen />
  }
  if (repo.isPending) return <RepoGitLoading />
  if (repo.isError) {
    return (
      <div data-route="repo-git" className="flex min-h-full flex-col">
        <RepoBackLink />
        <CenteredState
          icon={<TriangleAlertIcon size={16} />}
          tone="danger"
          title="Could not load the repository"
          subtitle={repo.error.message}
        />
      </div>
    )
  }
  const info = repo.data.info
  if (!info) {
    return (
      <div data-route="repo-git" className="flex min-h-full flex-col">
        <RepoBackLink />
        <CenteredState
          icon={<GitBranchIcon size={16} />}
          tone="neutral"
          title="Not a git repository"
          subtitle="cezar is running outside a git repository — start it inside one to browse changes, commits and branches."
        />
      </div>
    )
  }
  return <RepoView repo={repo.data} info={info} section={section} />
}

function RepoView({ repo, info, section }: { repo: RepoResponse; info: RepoInfo; section: GitSection }) {
  return (
    <div data-route="repo-git" data-git-section={section} className="flex min-h-full flex-col">
      <RepoBackLink />
      <header
        data-slot="repo-header"
        className="flex flex-col gap-1 px-[18px] pt-[18px] md:min-h-[61px] md:flex-row md:items-center md:gap-[10px] md:border-b md:border-border md:px-7 md:py-4"
      >
        <h1 className="min-w-0 flex-1 truncate text-2xl font-semibold tracking-tight md:text-[15px] md:tracking-normal">
          {gitSectionLabel(section, info.branch)}
        </h1>
        <p data-slot="repo-meta" className="min-w-0 truncate text-[12px] text-soft-foreground md:text-[11.5px]">
          <SectionMeta repo={repo} info={info} section={section} />
        </p>
      </header>

      {section === 'main' ? (
        <RepoCommitsSection repo={repo} info={info} />
      ) : section === 'not-landed' ? (
        <RepoNotLandedSection />
      ) : section === 'cleanup' ? (
        <div data-slot="repo-cleanup" className="flex flex-col gap-[16px] px-[18px] pt-[12px] pb-[calc(90px+env(safe-area-inset-bottom))] md:px-[20px] md:pb-[20px]">
          <WorktreesPanel />
          <CleanupBranchesCard base={repo.baseBranch ?? info.branch} />
        </div>
      ) : section === 'branches' ? (
        <RepoBranchesSection repo={repo} info={info} />
      ) : (
        <RepoChangesSection />
      )}
    </div>
  )
}

/** The header's meta line: one fact about the open section, in the soft ink the board uses. */
function SectionMeta({ repo, info, section }: { repo: RepoResponse; info: RepoInfo; section: GitSection }) {
  const base = repo.baseBranch ?? info.branch
  switch (section) {
    case 'main': {
      const count = repo.log.length === 0 ? 'no commits yet' : `latest ${repo.log.length} commit${repo.log.length === 1 ? '' : 's'} in the main checkout`
      return <>{count}{repo.tracking ? ` · ${fetchedAgo(repo.tracking)}` : ''}</>
    }
    case 'not-landed':
      return <>finished tasks whose commits are not on {base}</>
    case 'branches':
      return <>{repo.branches.length} local branch{repo.branches.length === 1 ? '' : 'es'} · on {info.branch}</>
    case 'changes':
      return <>{repo.status.length} uncommitted file{repo.status.length === 1 ? '' : 's'} in the main checkout</>
    case 'cleanup':
      // The section's invariant, stated where it applies; the server enforces it (issue 08 §C).
      return <>nothing here can delete work that is not on {base}</>
  }
}
