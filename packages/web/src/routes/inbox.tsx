import './task-flows.css'
import { Link } from '@/lib/project-router'
import { buttonVariants } from '@/components/ui/button'

/** An old bookmark explains where retained data lives; it never reads or changes that file. */
export function InboxRoute() {
  return (
    <div data-route="inbox" className="task-flow-page flex min-h-full flex-col gap-5">
      <h1 className="text-[28px] font-medium">Inbox has been removed</h1>
      <p className="text-sm text-muted-foreground">Agents no longer generate inbox suggestions. Create an ordinary task for work you want to run.</p>
      <p className="text-sm text-muted-foreground">Existing entries stay in <code>.ai/cezar/todos.json</code> in the original project. To export them, run this command from that project:</p>
      <pre className="overflow-x-auto rounded-xl border border-border bg-card p-4 text-sm"><code>cp .ai/cezar/todos.json ./cezar-followups-export.json</code></pre>
      <p className="text-sm text-muted-foreground">If the file is absent, there is nothing to export. Task Notes and Continue still work.</p>
      <Link to="/new" className={buttonVariants({ className: 'min-h-11 self-start' })}>New task</Link>
    </div>
  )
}
