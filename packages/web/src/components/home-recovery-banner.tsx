import type { HomeRecoveryFile } from '@open-mercato/cezar-api-client/contract/home-recovery'
import { useAcceptHomeRecovery, useHomeRecovery, useImportHomeRecovery, useRestoreHomeRecovery } from '@/api/home-recovery'
import { Button } from '@/components/ui/button'
import { useHealth } from '@/api/queries'

function recoveryMessage(file: HomeRecoveryFile): string {
  if (file.reason === 'legacy-change') return file.canImport
    ? `${file.file} changed in the old home. Import keeps live-only changes. Old-home changes win when both homes changed the same key or entry.`
    : `${file.file} changed in the old home. Import is unavailable. Ignore keeps the live file and skips these old-home changes.`
  if (file.reason === 'outside-write') return `${file.file} changed outside Cezar. Restore the previous version or accept the file as found.`
  return file.file === 'config.json'
    ? 'The project registry was reset. Restore the previous projects?'
    : 'The account list was reset. Restore the previous accounts?'
}

function HomeRecoveryRow({ file, editable }: { file: HomeRecoveryFile; editable: boolean | undefined }) {
  const restore = useRestoreHomeRecovery()
  const accept = useAcceptHomeRecovery()
  const importLegacy = useImportHomeRecovery()
  const legacy = file.reason === 'legacy-change'
  const busy = restore.isPending || accept.isPending || importLegacy.isPending
  const error = restore.error ?? accept.error ?? importLegacy.error
  const run = (action: 'restore' | 'accept' | 'import') => {
    restore.reset()
    accept.reset()
    importLegacy.reset()
    const incident = { file: file.file, detectedAt: file.detectedAt }
    if (action === 'restore') restore.mutate(incident)
    else if (action === 'accept') accept.mutate(incident)
    else importLegacy.mutate(incident)
  }
  return (
    <div data-slot="home-recovery" data-home-file={file.file} role="status" aria-live="polite" aria-busy={busy}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-muted/50 p-3 text-sm text-foreground">
      <span className="flex-[1_1_24rem] [min-inline-size:0] [overflow-wrap:break-word]">{recoveryMessage(file)}</span>
      {editable ? <div className="flex flex-wrap gap-2">
        {legacy ? file.canImport && <Button type="button" data-action="import" disabled={busy}
          onClick={() => run('import')}>Import changes from the old home</Button>
          : <Button type="button" data-action="restore" disabled={busy || !file.canRestore} onClick={() => run('restore')}>Restore</Button>}
        <Button type="button" variant="outline" data-action="accept" disabled={busy} onClick={() => run('accept')}>{legacy ? 'Ignore' : 'Accept as found'}</Button>
      </div> : editable === false && <p className="basis-full">{legacy
        ? (file.canImport ? 'Only the host operator can import or ignore this file.' : 'Only the host operator can ignore this file.')
        : 'Only the host operator can restore or accept this file.'}
        {file.file.startsWith('remote-settings/') && (legacy
          ? <> {file.canImport && <><code>cez backup import {file.file}</code> or </>}<code>cez backup ignore {file.file}</code></>
          : <> <code>cez backup restore {file.file}</code></>)}
      </p>}
      {editable && error && <p role="alert" className="basis-full text-danger">{error.message}</p>}
    </div>
  )
}

/** Empty successful state remains observable without adding a visible banner or placeholder. */
export function HomeRecoveryBanner() {
  const recovery = useHomeRecovery()
  const editable = useHealth().data?.capabilities?.localHandoff
  return (
    <div data-slot="home-recovery-state" data-state={recovery.isSuccess ? 'ready' : recovery.isError ? 'error' : 'pending'}>
      {recovery.data?.files.map(file => <HomeRecoveryRow key={file.file} file={file}
        editable={file.file.startsWith('remote-settings/') ? false : editable} />)}
    </div>
  )
}
