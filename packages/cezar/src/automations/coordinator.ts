import { projectPaths, readProjectPath } from '../project-paths.ts';
import { existsSync } from 'node:fs';
import { AutomationStore } from './store.ts';

export interface AutomationProjectSource {
  id: string;
  root: string;
  status: 'ok' | 'missing' | 'not-git';
}

export interface AutomationCoordinatorOptions {
  listProjects: () => Promise<readonly AutomationProjectSource[]>;
  warn?: (message: string) => void;
}

/**
 * Lightweight workspace index for project automation state. Discovery checks
 * only the optional definitions file and never materializes a RunManager or a
 * full ProjectContext. Schedulers attach to these handles in Phase 4.
 */
export class AutomationCoordinator {
  private readonly stores = new Map<string, AutomationStore>();
  private readonly roots = new Map<string, string>();
  private seenProject = false;
  private refreshSeq = 0;

  constructor(private readonly options: AutomationCoordinatorOptions) {}

  async refresh(): Promise<void> {
    let projects: readonly AutomationProjectSource[];
    const seq = ++this.refreshSeq;
    try {
      projects = await this.options.listProjects();
    } catch (error) {
      this.options.warn?.(`Unable to refresh GitHub automations: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (projects.some((project) => project.status !== 'missing')) this.seenProject = true;
    // A read that a newer one overtook keeps its sighting but never applies its project state.
    if (seq !== this.refreshSeq) return;
    const present = new Set(projects.map((project) => project.id));
    for (const id of this.stores.keys()) {
      if (!present.has(id)) this.remove(id);
    }
    for (const project of projects) {
      if (project.status === 'missing') {
        this.remove(project.id);
        continue;
      }
      this.roots.set(project.id, project.root);
      // A store this process already holds is re-read when another cockpit changed its files;
      // a project whose definitions file appeared since the last refresh is opened here.
      const existing = this.stores.get(project.id);
      if (existing) this.reloadQuietly(existing);
      else if (existsSync(readProjectPath(project.root, 'automations.json'))) this.store(project.id, project.root);
    }
  }

  /**
   * At least one registered project is known (its root is not missing), with or without a
   * definitions file: the workspace timer keeps an idle wake so a file another cockpit creates
   * later is discovered by `refresh`.
   */
  hasProjects(): boolean {
    return this.roots.size > 0;
  }

  /**
   * A project was registered at some earlier refresh, even if a later registry read lists none. The
   * workspace timer keeps its idle wake on this: a briefly empty or unreadable registry must not
   * stop the only timer, because nothing else would arm it again. Recorded at refresh time, so a
   * refresh that a newer one supersedes still counts.
   */
  hasSeenProject(): boolean {
    return this.seenProject;
  }

  private reloadQuietly(store: AutomationStore): void {
    try {
      store.reloadIfChanged();
    } catch (error) {
      this.options.warn?.(`Unable to re-read automations: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  store(projectId: string, root?: string): AutomationStore | undefined {
    const existing = this.stores.get(projectId);
    if (existing) return existing;
    const projectRoot = root ?? this.roots.get(projectId);
    if (!projectRoot) return undefined;
    const store = AutomationStore.open(projectPaths(projectRoot).write, { warn: this.options.warn });
    this.stores.set(projectId, store);
    this.roots.set(projectId, projectRoot);
    return store;
  }

  enabledProjectIds(): string[] {
    return [...this.stores.entries()]
      .filter(([, store]) => store.list().some((definition) => definition.enabled))
      .map(([id]) => id);
  }

  remove(projectId: string): void {
    this.stores.delete(projectId);
    this.roots.delete(projectId);
  }

  ids(): string[] {
    return [...this.stores.keys()];
  }
}
