import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { reportIo } from './report-fixture-preload.mjs'

/** Reports workload commands, independent of the built revision under measurement. */
/** `dataDir(root)` is the project's write root, as the built revision's `projectPaths` selects it. */
export function createReportFixture({ stores, projects, root, publishArtifact, artifactDirectory, dataDir }) {
  let fixture, timer
  const reportTitles = new Map()
  const stop = () => { clearInterval(timer) }
  const setup = async () => {
      const settled = [], live = [], artifacts = []
      const source = join(root, 'fixture-report.html'); writeFileSync(source, '<title>Fixture report</title><p>Snapshot</p>')
      for (const [projectId, target] of stores) {
        for (let i = 0; i < (projectId === 'boot' ? 65 : 5); i++) {
          const run = target.createRun({ title: `Report source ${projectId} ${i}`, task: 'Reports workload', workflow: 'quick-task', steps: [] })
          target.updateRun(run.id, { status: 'running' })
          if (projectId === 'boot' && i < 60) {
            for (let n = 0; n < 2; n++) {
              const artifact = await publishArtifact(artifactDirectory(dataDir(projects.find(p => p.id === projectId).root), run.id), run.id, source)
              artifacts.push({ id: artifact.id, runId: run.id, taskTitle: run.title })
            }
            target.updateRun(run.id, { status: 'done' }); settled.push({ projectId, runId: run.id })
          } else { target.updateRun(run.id, { status: 'running' }); live.push({ projectId, runId: run.id }) }
        }
        target.flush()
      }
      fixture = { settled, live, artifacts }
  }
  const start = () => {
    stop()
      let tick = 0
      timer = setInterval(() => {
        const run = fixture.live[tick % fixture.live.length]
        const title = `Live title ${++tick}`
        stores.get(run.projectId).updateRun(run.runId, { title }); stores.get(run.projectId).flush()
        reportTitles.set(run.runId, title)
      }, 200)
  }
  const publish = async () => {
      const run = fixture.live[0], target = stores.get(run.projectId)
      const source = join(root, 'new-report.html'); writeFileSync(source, '<title>New publication</title><p>New</p>')
      const artifact = await publishArtifact(artifactDirectory(dataDir(root), run.runId), run.runId, source)
      target.updateRun(run.runId, { title: 'Publication event' }); target.flush()
      reportTitles.set(run.runId, 'Publication event')
      fixture.publication = { id: artifact.id, at: Date.now(), runId: run.runId }
  }
  return {
    async handle(command) {
      if (command.reportsStop) stop()
      if (command.reportsSetup) await setup()
      if (command.reportsStart) start()
      if (command.reportsPublish) await publish()
      if (command.resetIo) for (const key of Object.keys(reportIo)) reportIo[key] = 0
    },
    state: () => ({ reportsFixture: fixture, reportTitles: Object.fromEntries(reportTitles) }),
    stop,
  }
}
