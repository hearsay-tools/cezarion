import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryScope, sidebarLimitsSchema, normalizeSidebarLimits, type SidebarLimits } from '@open-mercato/cezar-api-client'
import { putUiState } from '@/api/client'
import { useProjectUiState } from '@/api/queries'
import { Button } from '@/components/ui/button'

const fields = [
  ['overall', 'Overall'], ['needsYou', 'Needs You'], ['finished', 'Finished'], ['working', 'Working'],
] as const

export function SidebarSection() {
  const scope = queryScope()
  const state = useProjectUiState(scope)
  if (state.isPending) return <p role="status" className="p-4 text-sm text-muted-foreground">Loading sidebar settings…</p>
  if (state.isError) return <div className="space-y-3 p-4">
    <p role="alert">Sidebar settings did not load: {state.error.message}</p>
    <Button className="min-h-[44px]" onClick={() => void state.refetch()}>Retry</Button>
  </div>
  return <SidebarForm key={scope} scope={scope} initial={state.data.sidebarLimits ?? {}} />
}

function SidebarForm({ scope, initial }: { scope: string; initial: SidebarLimits }) {
  const queryClient = useQueryClient()
  const defaults = normalizeSidebarLimits(undefined)
  const incoming = formValues(initial)
  const [form, setForm] = useState(() => ({ values: incoming, saved: incoming, received: incoming }))
  const { values, saved } = form
  const setValues = (next: typeof values) => setForm(current => ({ ...current, values: next }))
  const parsed = sidebarLimitsSchema.safeParse(Object.fromEntries(fields.map(([key]) => [key, values[key] === null ? null : Number(values[key])])))
  const invalid = (key: keyof SidebarLimits) => values[key] !== null && (values[key]!.trim() === '' || !Number.isSafeInteger(Number(values[key])) || Number(values[key]) <= 0)
  const dirty = fields.some(([key]) => values[key] !== saved[key])
  const save = useMutation({
    onMutate: () => queryClient.cancelQueries({ queryKey: [scope, 'ui-state'], exact: true }),
    mutationFn: (limits: SidebarLimits) => putUiState({ sidebarLimits: limits }, scope),
    onSuccess: async result => {
      // A reconnect/refetch may have started another read while PUT was in flight.
      await queryClient.cancelQueries({ queryKey: [scope, 'ui-state'], exact: true })
      queryClient.setQueryData([scope, 'ui-state'], result)
      const next = formValues(result.sidebarLimits)
      setForm({ values: next, saved: next, received: next })
    },
  })
  // Adopt refreshed preferences before painting a pristine form. Dirty drafts survive;
  // their baseline still follows the latest saved state. A pending save owns its result.
  if (!save.isPending && !sameValues(form.received, incoming)) {
    setForm({ values: dirty ? values : incoming, saved: incoming, received: incoming })
  }
  return <form data-slot="sidebar-settings" className="flex w-full max-w-2xl flex-col gap-5 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6" onSubmit={event => {
    event.preventDefault()
    if (parsed.success && !fields.some(([key]) => invalid(key)) && !save.isPending) save.mutate(parsed.data)
  }}>
    <p id="sidebar-limits-help" className="text-sm text-muted-foreground">
      Limits apply to this project on desktop and mobile. The overall budget is shared in section order: Needs You, Finished, then Working. Each section also respects its own limit. Unlimited removes only that constraint.
    </p>
    <p className="text-sm text-muted-foreground">Pinned tasks and groups containing a pin bypass both limits. A task group counts as one row. Archived uses only the overall limit; archived pins are not exempt.</p>
    {fields.map(([key, label]) => <div key={key} className="flex flex-col gap-1">
      <label htmlFor={`sidebar-${key}`} className="text-sm font-medium">{label}</label>
      <div className="flex flex-wrap items-center gap-3">
        <input id={`sidebar-${key}`} type="number" inputMode="numeric" min="1" step="1"
          value={values[key] ?? ''} disabled={values[key] === null || save.isPending}
          aria-invalid={invalid(key)} aria-describedby={invalid(key) ? `sidebar-${key}-error sidebar-limits-help` : 'sidebar-limits-help'}
          onChange={event => setValues({ ...values, [key]: event.target.value })}
          className="min-h-[44px] w-28 rounded-md border border-input bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" />
        <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" aria-label={`${label} Unlimited`} checked={values[key] === null} disabled={save.isPending}
            onChange={event => setValues({ ...values, [key]: event.target.checked ? null : String(defaults[key] ?? 10) })}
            className="size-4 accent-[var(--accent-strong)]" />
          Unlimited
        </label>
      </div>
      {invalid(key) && <p id={`sidebar-${key}-error`} className="text-sm text-danger">Enter a positive whole number or choose Unlimited.</p>}
    </div>)}
    <Button type="submit" className="min-h-[44px] self-start" variant="primary" disabled={!dirty || !parsed.success || fields.some(([key]) => invalid(key)) || save.isPending}>
      {save.isPending ? 'Saving…' : 'Save sidebar limits'}
    </Button>
    {save.isError && <p role="alert" className="text-sm text-danger">Could not save sidebar limits: {save.error.message}</p>}
    {save.isSuccess && !dirty && <p role="status" className="text-sm text-muted-foreground">Sidebar limits saved.</p>}
  </form>
}

function formValues(limits: unknown): Record<keyof SidebarLimits, string | null> {
  const normalized = normalizeSidebarLimits(limits)
  return Object.fromEntries(fields.map(([key]) => [key, normalized[key] === null ? null : String(normalized[key])])) as Record<keyof SidebarLimits, string | null>
}

function sameValues(left: ReturnType<typeof formValues>, right: ReturnType<typeof formValues>): boolean {
  return fields.every(([key]) => left[key] === right[key])
}
