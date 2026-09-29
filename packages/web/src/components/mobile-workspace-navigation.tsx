import { Link } from 'react-router'
import { ChevronDownIcon } from '@/components/design-icons'
import { useHealth, useProjects } from '@/api/queries'
import { scopeTo } from '@/lib/project-router'
import { AddProjectMenu, useSidebarNavigate } from './app-shell'
import { ThemeToggle } from './theme-toggle'
import { Button } from './ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu'

/** Preserve workspace access where the desktop rail is hidden. Only mounted in the drawer. */
export function MobileWorkspaceNavigation() {
  const projects = useProjects().data?.projects ?? []
  const singleProject = useHealth().data?.capabilities.singleProject === true
  const onNavigate = useSidebarNavigate()
  return <div data-slot="mobile-workspace-navigation" className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1">
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" className="mr-auto min-h-11">Projects<ChevronDownIcon /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {projects.filter(project => project.status !== 'missing').map(project => <DropdownMenuItem asChild key={project.id}><Link to={scopeTo(project.id, '/')} onClick={onNavigate}>{project.name}</Link></DropdownMenuItem>)}
        <DropdownMenuSeparator />
        {!singleProject ? <DropdownMenuItem asChild><Link to="/tasks" onClick={onNavigate}>All tasks</Link></DropdownMenuItem> : null}
        <DropdownMenuItem asChild><Link to="/settings/global" onClick={onNavigate}>Global settings</Link></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {!singleProject ? <AddProjectMenu origin="mobile" triggerClassName="size-11" /> : null}
    <ThemeToggle />
  </div>
}
