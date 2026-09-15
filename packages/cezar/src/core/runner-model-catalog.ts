import type { EffortLevel } from '@open-mercato/cezar-contract';
import type { RunnerId } from './agent-runner.ts';

export interface ModelOption {
  id: string;
  label: string;
  description: string;
  effortLevels?: EffortLevel[];
}

export type ModelCatalogSource = 'live' | 'cache' | 'unavailable';

export interface RunnerModelCatalogResult {
  runner: RunnerId;
  models: ModelOption[];
  source: ModelCatalogSource;
  stale: boolean;
  reason?: string;
}

export interface RunnerModelCatalogAdapter {
  discover(): Promise<ModelOption[]>;
}

export interface RunnerModelCatalogOptions {
  adapters: Partial<Record<RunnerId, RunnerModelCatalogAdapter>>;
  now?: () => number;
  ttlMs?: number;
}

interface CachedCatalog {
  models: ModelOption[];
  expiresAt: number;
  failureReason?: string;
}

const DEFAULT_TTL_MS = 5 * 60 * 1_000;

/** Host-level, in-memory model discovery cache shared by every workspace. */
export class RunnerModelCatalog {
  readonly #adapters: Partial<Record<RunnerId, RunnerModelCatalogAdapter>>;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #cache = new Map<RunnerId, CachedCatalog>();
  readonly #inFlight = new Map<RunnerId, Promise<RunnerModelCatalogResult>>();
  readonly #generation = new Map<RunnerId, number>();

  constructor(options: RunnerModelCatalogOptions) {
    this.#adapters = options.adapters;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  invalidate(runner: RunnerId): void {
    const cached = this.#cache.get(runner);
    if (cached) cached.expiresAt = 0;
    this.#inFlight.delete(runner);
    this.#generation.set(runner, (this.#generation.get(runner) ?? 0) + 1);
  }

  get(runner: RunnerId): Promise<RunnerModelCatalogResult> {
    const cached = this.#cache.get(runner);
    if (cached && this.#now() < cached.expiresAt) {
      if (cached.failureReason) {
        return Promise.resolve({
          runner,
          models: cached.models,
          source: cached.models.length > 0 ? 'cache' : 'unavailable',
          stale: cached.models.length > 0,
          reason: cached.failureReason,
        });
      }
      return Promise.resolve({ runner, models: cached.models, source: 'cache', stale: false });
    }

    const pending = this.#inFlight.get(runner);
    if (pending) return pending;

    const generation = this.#generation.get(runner) ?? 0;
    const refresh = this.#refresh(runner, cached, generation).finally(() => {
      if ((this.#generation.get(runner) ?? 0) === generation) this.#inFlight.delete(runner);
    });
    this.#inFlight.set(runner, refresh);
    return refresh;
  }

  async #refresh(
    runner: RunnerId,
    cached: CachedCatalog | undefined,
    generation: number,
  ): Promise<RunnerModelCatalogResult> {
    const current = () => (this.#generation.get(runner) ?? 0) === generation;
    try {
      const adapter = this.#adapters[runner];
      if (!adapter) throw new Error('adapter unavailable');
      const models = await adapter.discover();
      const value = { models: [...models], expiresAt: this.#now() + this.#ttlMs };
      if (current()) this.#cache.set(runner, value);
      return { runner, models: value.models, source: 'live', stale: false };
    } catch {
      const reason = unavailableReason(runner);
      if (cached) {
        if (current()) {
          this.#cache.set(runner, { models: cached.models, expiresAt: this.#now() + this.#ttlMs, failureReason: reason });
        }
        return { runner, models: cached.models, source: 'cache', stale: true, reason };
      }
      if (current()) {
        this.#cache.set(runner, { models: [], expiresAt: this.#now() + this.#ttlMs, failureReason: reason });
      }
      return { runner, models: [], source: 'unavailable', stale: false, reason };
    }
  }
}

const RUNNER_DISPLAY_NAME: Record<RunnerId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};

function unavailableReason(runner: RunnerId): string {
  return `${RUNNER_DISPLAY_NAME[runner]} model discovery is temporarily unavailable`;
}
