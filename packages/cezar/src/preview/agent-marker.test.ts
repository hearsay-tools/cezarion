import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAgentMarker, markAgentConnected, reconcileAgentMarkers } from './agent-marker.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-agent-marker-'));
  dirs.push(dir);
  return dir;
}

function store(runIds: string[]) {
  const events: Array<{ runId: string; event: Record<string, unknown> }> = [];
  return {
    events,
    getRun: (id: string) => (runIds.includes(id) ? ({ id } as never) : undefined),
    appendEvent: (runId: string, event: Record<string, unknown>) => { events.push({ runId, event }); return event as never; },
  };
}

const marker = (dir: string, runId: string) => join(dir, 'preview', runId, 'agent-connected');

describe('agent crash markers (hearsay-tools/cezarion#784)', () => {
  it('a marker left by a crash gets the disconnected it missed, once, and goes', () => {
    const dir = dataDir();
    markAgentConnected(dir, 'run-1');
    const runs = store(['run-1']);
    expect(reconcileAgentMarkers(dir, runs, () => false)).toBe(1);
    expect(runs.events).toEqual([{ runId: 'run-1', event: { type: 'preview.agent-browser', state: 'disconnected' } }]);
    expect(existsSync(marker(dir, 'run-1'))).toBe(false);
    expect(reconcileAgentMarkers(dir, runs, () => false)).toBe(0);
    expect(runs.events).toHaveLength(1);
  });

  it("spares a run whose agent this process holds, and drops a deleted run's marker without an event", () => {
    const dir = dataDir();
    markAgentConnected(dir, 'live');
    markAgentConnected(dir, 'deleted');
    mkdirSync(join(dir, 'preview', 'no-marker'), { recursive: true });
    writeFileSync(join(dir, 'preview', 'no-marker', 'chromium.pid.json'), '{}');
    const runs = store(['live', 'no-marker']);
    expect(reconcileAgentMarkers(dir, runs, runId => runId === 'live')).toBe(1);
    expect(runs.events).toEqual([]);
    expect(existsSync(marker(dir, 'live'))).toBe(true);
    expect(existsSync(marker(dir, 'deleted'))).toBe(false);
  });

  it('reconciles nothing without a preview directory, and clearing a missing marker is quiet', () => {
    const dir = dataDir();
    expect(reconcileAgentMarkers(dir, store([]), () => false)).toBe(0);
    expect(() => clearAgentMarker(dir, 'run-1')).not.toThrow();
  });
});
