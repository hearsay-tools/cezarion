import { existsSync } from 'node:fs';
import { join } from 'node:path';
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

  constructor(private readonly options: AutomationCoordinatorOptions) {}

  async refresh(): Promise<void> {
    let projects: readonly AutomationProjectSource[];
    try {
      projects = await this.options.listProjects();
    } catch (error) {
      this.options.warn?.(`Unable to refresh GitHub automations: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
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
      else if (existsSync(join(project.root, '.ai/cezar/automations.json'))) this.store(project.id, project.root);
    }
  }

  /** At least one known project carries a definitions file: the workspace timer keeps watching. */
  hasDefinitions(): boolean {
    return [...this.stores.values()].some((store) => store.hasDefinitionsFile());
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
    const store = AutomationStore.open(join(projectRoot, '.ai/cezar'), { warn: this.options.warn });
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
