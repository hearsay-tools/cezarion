import '../task-flows.css'
import type { ReactNode } from 'react'

/** The page chrome every automations screen shares: title, subtitle, an action row, then the body.
 *  16 px gutters under `md`, where `.task-flow-page`'s 36 px would eat a 390 px viewport. */
export function PageFrame({ title, subtitle, action, children }: { title: string; subtitle: string; action?: ReactNode; children: ReactNode }) {
  return (
    <main data-route="automations" className="task-flow-page w-full max-w-full min-w-0 max-md:p-4!">
      <header className="mb-6 flex flex-col items-start gap-5 max-md:mb-4 max-md:gap-3">
        <div className="min-w-0">
          <h1 className="mb-2 text-[28px] font-medium max-md:text-[22px]">{title}</h1>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
        {action}
      </header>
      {children}
    </main>
  )
}

export function PageState({ text }: { text: string }) {
  return <div role="status" className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">{text}</div>
}
