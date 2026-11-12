import type { ReportsFrame, ReportsMetadata } from '@open-mercato/cezar-contract/reports';
import { reportsIndex, type ReportsIndex } from '../artifacts/reports-index.ts';
import type { SocketHub, TopicPublisher } from './ws.ts';
import type { WorkspaceProjects } from './workspace-projects.ts';

export function reportsPublisher(index: ReportsIndex): TopicPublisher {
  return {
    snapshot: async () => ({ type: 'snapshot', ...index.state() }),
    start(publish) {
      const release = index.watch();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let content = false;
      const runs = new Map<string, ReportsMetadata>();
      const off = index.onChange(frame => {
        if (frame.type === 'content') content = true;
        if (frame.type === 'metadata') for (const run of frame.runs) runs.set(run.runId, run);
        timer ??= setTimeout(() => {
          timer = undefined;
          const next: ReportsFrame = content ? { type: 'content', ...index.state() }
            : { type: 'metadata', ...index.state(), runs: [...runs.values()] };
          content = false; runs.clear(); publish(next);
        }, 500);
        timer.unref?.();
      });
      return () => { clearTimeout(timer); off(); release(); };
    },
  };
}

export function registerReportsTopic(hub: SocketHub, projects: Pick<WorkspaceProjects, 'resolveLiveProject'>): void {
  hub.registerTopicFamily('reports:project:', async projectId => {
    const project = await projects.resolveLiveProject(projectId);
    if (project.store.unavailable) return undefined;
    return reportsPublisher(reportsIndex(project.store));
  }, { loopbackReadable: false });
}
