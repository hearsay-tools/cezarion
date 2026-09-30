import { ArrowLeftIcon } from '@/components/design-icons'
import { Link } from '@/lib/project-router'

/** The phone's way back to the Git screen; present through every repository data gate.
 *  Own file: the loading surface is eager (routes.tsx), the repository view is a lazy chunk. */
export function RepoBackLink() {
  return (
    <div className="px-[18px] pt-2 md:hidden">
      <Link to="/git" data-slot="git-back" className="inline-flex min-h-11 items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeftIcon size={16} aria-hidden="true" className="size-3.5" />
        Back to Git
      </Link>
    </div>
  )
}
