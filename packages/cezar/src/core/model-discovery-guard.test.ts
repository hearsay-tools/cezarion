/**
 * Host model discovery guard — AGENT_PROTOCOL.md §10, "Host model discovery".
 *
 * Discovery landed one runner at a time (#1 pi, #18 invalidation, #74 codex reasons, #89
 * claude), so nothing derived it from `RUNNER_IDS`: `modelDiscoveryRunnerSchema` is a hand-kept
 * enum and `RunnerModelCatalog` takes a `Partial` adapter map. A runner added without its
 * adapter therefore fails nowhere — the picker just shows presets again. This suite makes that
 * a red test. A runner whose CLI has no model-listing surface at all is recorded in
 * `MODEL_DISCOVERY_EXEMPTIONS` with the wire reason, never "not implemented yet".
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_DISCOVERY_RUNNERS } from '@open-mercato/cezar-contract';
import { describe, expect, it } from 'vitest';
import { RUNNER_IDS, type RunnerId } from './agent-runner.ts';
import { hostModelCatalogAdapters } from './host-model-catalog.ts';

interface ModelDiscoveryExemption {
  readonly runner: RunnerId;
  /** Why this runner's CLI cannot list models. Never "not implemented yet". */
  readonly reason: string;
}

/** Runners with no host-local model catalog to discover. Empty today: all four discover. */
export const MODEL_DISCOVERY_EXEMPTIONS: readonly ModelDiscoveryExemption[] = [];

const here = dirname(fileURLToPath(import.meta.url));
const exempt = (runner: RunnerId): boolean => MODEL_DISCOVERY_EXEMPTIONS.some((e) => e.runner === runner);
const required = RUNNER_IDS.filter((runner) => !exempt(runner));
const adapterModule = (runner: RunnerId): string => `${runner}-model-catalog.ts`;
const discoverExport = (runner: RunnerId): string =>
  `discover${runner.charAt(0).toUpperCase()}${runner.slice(1)}Models`;

describe('host model discovery guard (AGENT_PROTOCOL.md §10)', () => {
  it('covers every runner: RUNNER_IDS minus the exemptions is the set under test', () => {
    // Guards the guard: an exemption must name a real runner with a real reason, and the
    // remaining set must be non-empty so the it.each blocks below actually run.
    for (const exemption of MODEL_DISCOVERY_EXEMPTIONS) {
      expect(RUNNER_IDS).toContain(exemption.runner);
      expect(exemption.reason.trim().length).toBeGreaterThan(0);
      expect(exemption.reason).not.toMatch(/not implemented/i);
    }
    expect(required.length).toBeGreaterThan(0);
  });

  it.each(required)('%s is a member of the contract enum modelDiscoveryRunnerSchema', (runner) => {
    expect(MODEL_DISCOVERY_RUNNERS).toContain(runner);
  });

  it.each(required)('%s ships a bounded catalog adapter module exporting discover<Runner>Models', async (runner) => {
    const file = adapterModule(runner);
    expect(existsSync(join(here, file)), `packages/cezar/src/core/${file} is missing`).toBe(true);
    const mod = (await import(/* @vite-ignore */ `./${file}`)) as Record<string, unknown>;
    expect(typeof mod[discoverExport(runner)], `${file} must export ${discoverExport(runner)}`).toBe('function');
  });

  it.each(required)('%s is registered on the host RunnerModelCatalog', (runner) => {
    const adapters = hostModelCatalogAdapters('/nonexistent') as Partial<Record<RunnerId, unknown>>;
    expect(adapters[runner], `hostModelCatalogAdapters() has no ${runner} entry`).toBeDefined();
  });

  it('advertises discovery only for runners that exist', () => {
    // The contract enum must not name a runner RUNNER_IDS no longer has, and an exempt runner
    // must not be advertised as discoverable either — the picker would ask for a catalog that
    // can never answer.
    for (const runner of MODEL_DISCOVERY_RUNNERS) {
      expect(RUNNER_IDS).toContain(runner);
      expect(exempt(runner as RunnerId), `${runner} is exempt but still in modelDiscoveryRunnerSchema`).toBe(false);
    }
  });
});
