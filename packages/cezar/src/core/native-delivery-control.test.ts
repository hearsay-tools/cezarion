import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryControl, readDeliveryControl, type DeliveryControlOptions, type DeliveryKind } from '../../scripts/mock-delivery-control.mjs';
import { RUNNER_IDS, type AgentEvent, type AgentSession, type RunnerId } from './agent-runner.ts';
import { driveSeam, exemptionFor, waitFor } from './harness-parity.testkit.ts';

// These tests exercise the native mocks as test infrastructure: ignoring a configured
// control would make delivery tests silently run the ordinary scenario.
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'cez-native-delivery-')); roots.push(root);
  return root;
}
function reader(control: { path: string }, kinds: Parameters<typeof readDeliveryControl>[0] = ['reject', 'hold-ack', 'hold-response']) {
  vi.stubEnv('CEZ_MOCK_DELIVERY_CONTROL', control.path);
  return readDeliveryControl(kinds);
}

describe('native delivery control module', () => {
  it.each([
    { kind: 'hold-ack', match: '' },
    { kind: 'hold-ack', match: 'x', persistent: true },
    { kind: 'other', match: 'x' },
    { kind: 'reject', match: 'x', extra: 1 },
  ])('refuses an invalid control %j', options => {
    expect(() => createDeliveryControl(tempRoot(), options as unknown as DeliveryControlOptions)).toThrow();
  });

  it.each([
    ['an empty variable', () => ''],
    ['a relative path', () => 'control.json'],
    ['a missing file', () => join(tempRoot(), 'missing.json')],
    ['invalid JSON', () => { const path = join(tempRoot(), 'bad.json'); writeFileSync(path, '{'); return path; }],
    ['an unsupported kind', () => createDeliveryControl(tempRoot(), { kind: 'reject', match: 'x' }).path],
  ])('fails closed on %s', (_name, path) => {
    vi.stubEnv('CEZ_MOCK_DELIVERY_CONTROL', path());
    expect(() => readDeliveryControl(['hold-response'])).toThrow(/^CEZ_MOCK_DELIVERY_CONTROL: /);
  });

  it('claims a rejection once across readers', () => {
    const control = createDeliveryControl(tempRoot(), { kind: 'reject', match: 'reject-owned-turn' });
    const first = reader(control), second = reader(control);
    expect(first.rejects('other')).toBe(false);
    expect(first.rejects('x reject-owned-turn')).toBe(true);
    expect(second.rejects('x reject-owned-turn')).toBe(false);
    expect(first.rejects('x reject-owned-turn')).toBe(false);
  });

  it('keeps a persistent rejection until lift', () => {
    const control = createDeliveryControl(tempRoot(), { kind: 'reject', match: 'reject-owned-turn', persistent: true });
    const first = reader(control), second = reader(control);
    expect(first.rejects('reject-owned-turn')).toBe(true);
    expect(second.rejects('reject-owned-turn')).toBe(true);
    control.lift();
    expect(first.rejects('reject-owned-turn')).toBe(false);
    expect(second.rejects('reject-owned-turn')).toBe(false);
  });

  it('holds a matching acknowledgement until release without blocking', async () => {
    const control = createDeliveryControl(tempRoot(), { kind: 'hold-ack', match: 'delay-owned-ack' });
    const delivery = reader(control);
    const plain = vi.fn();
    delivery.ack('other', plain);
    expect(plain).toHaveBeenCalledTimes(1);
    const held = vi.fn();
    delivery.ack('x delay-owned-ack', held);
    expect(held).not.toHaveBeenCalled();
    expect(control.held()).toBe(true);
    control.release();
    // bound: the release is observed by a 5 ms poll; 10 s only guards a hang.
    await vi.waitFor(() => expect(held).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    // A release is permanent: a later match is acknowledged at once.
    const later = vi.fn();
    delivery.ack('delay-owned-ack again', later);
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('holds a matching response until release', async () => {
    const control = createDeliveryControl(tempRoot(), { kind: 'hold-response', match: 'mock:hold' });
    const delivery = reader(control);
    expect(delivery.holdResponse('other')).toBeUndefined();
    expect(control.held()).toBe(false);
    let resolved = false;
    const pending = delivery.holdResponse('mock:hold').then(() => { resolved = true; });
    expect(control.held()).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(resolved).toBe(false);
    control.release();
    await pending;
    expect(resolved).toBe(true);
  });

  it('applies only its own kind', async () => {
    const control = createDeliveryControl(tempRoot(), { kind: 'hold-response', match: 'm' });
    const delivery = reader(control);
    expect(delivery.rejects('m')).toBe(false);
    const send = vi.fn();
    delivery.ack('m', send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(control.held()).toBe(false);
  });
});

// What each native wire can carry. Claude acknowledges agent input with its local stdin
// write, and Cursor print cannot refuse an input, so those kinds are named exemptions.
const EXEMPT: Partial<Record<RunnerId, Partial<Record<DeliveryKind, string>>>> = {
  claude: { reject: 'U13', 'hold-ack': 'U12' },
  cursor: { reject: 'U13' },
};
const ENV_BASE = { CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '', CEZ_MOCK_ARGS_FILE: '' };
type Wire = { v1: AgentEvent[] };
/** A baseline turn on a fresh native subprocess, then `exercise` once it has ended. */
function seam(runner: RunnerId, path: string, exercise?: (session: AgentSession, wire: Wire) => Promise<void>) {
  return driveSeam(runner, 'baseline', {
    spec: { env: { ...ENV_BASE, CEZ_MOCK_DELIVERY_CONTROL: path } },
    whileOpen: async (session, wire) => {
      await waitFor(() => wire.v1.some(event => event.type === 'turn-end' || event.type === 'error'));
      expect(wire.v1.filter(event => event.type === 'error')).toEqual([]);
      await exercise?.(session, wire);
    },
  });
}
const send = (session: AgentSession, text: string) => {
  const ack = session.sendAgentMessage([{ type: 'text', text }]);
  if (!ack) throw new Error('expected a reserved submission');
  const state = { settled: false, rejected: false };
  const done = ack.then(() => { state.settled = true; }, () => { state.settled = true; state.rejected = true; });
  return { state, done };
};
const echoed = (wire: Wire, marker: string) => wire.v1.some(event => event.type === 'text' && event.text.includes(marker));
const turnEnds = (wire: Wire) => wire.v1.filter(event => event.type === 'turn-end').length;

describe.each(RUNNER_IDS)('%s native delivery control', runner => {
  const exempt = (kind: DeliveryKind) => EXEMPT[runner]?.[kind];
  const control = (options: DeliveryControlOptions) => createDeliveryControl(tempRoot(), options);

  it('rejects one matching input, and a reopened process accepts it', async () => {
    if (exempt('reject')) return;
    const rejectOnce = control({ kind: 'reject', match: 'reject-owned-turn' });
    await seam(runner, rejectOnce.path, async (session, wire) => {
      const input = send(session, 'mock:agent-echo reject-owned-turn');
      await input.done;
      expect(input.state.rejected).toBe(true);
      expect(echoed(wire, 'reject-owned-turn')).toBe(false);
    });
    await seam(runner, rejectOnce.path, async (session, wire) => {
      const input = send(session, 'mock:agent-echo reject-owned-turn');
      await input.done;
      expect(input.state.rejected).toBe(false);
      await waitFor(() => echoed(wire, 'reject-owned-turn') && turnEnds(wire) === 2);
    });
  }, 60_000);

  it('keeps a persistent rejection across processes until lift, without affecting another fixture', async () => {
    if (exempt('reject')) return;
    const options = { kind: 'reject', match: 'reject-owned-turn', persistent: true } as const;
    const persistent = control(options), other = control(options);
    const rejected = (path: string) => seam(runner, path, async session => {
      const input = send(session, 'mock:agent-echo reject-owned-turn');
      await input.done;
      expect(input.state.rejected).toBe(true);
    });
    await rejected(persistent.path);
    await rejected(persistent.path);
    persistent.lift();
    await seam(runner, persistent.path, async (session, wire) => {
      const input = send(session, 'mock:agent-echo reject-owned-turn');
      await input.done;
      expect(input.state.rejected).toBe(false);
      await waitFor(() => echoed(wire, 'reject-owned-turn'));
    });
    await rejected(other.path);
  }, 60_000);

  it('accepts a matching input on the same process once the rejection is lifted', async () => {
    if (exempt('reject')) return;
    const persistent = control({ kind: 'reject', match: 'reject-owned-turn', persistent: true });
    await seam(runner, persistent.path, async (session, wire) => {
      const rejected = send(session, 'mock:agent-echo reject-owned-turn first');
      await rejected.done;
      expect(rejected.state.rejected).toBe(true);
      persistent.lift();
      // The OpenCode runner fails its session on a rejected prompt POST, so the retry needs a
      // reopened process (the cell above); the other protocol runners keep the session open.
      if (runner === 'opencode') { expect(session.sendAgentMessage([{ type: 'text', text: 'retry' }])).toBe(false); return; }
      const accepted = send(session, 'mock:agent-echo reject-owned-turn second');
      await accepted.done;
      expect(accepted.state.rejected).toBe(false);
      await waitFor(() => echoed(wire, 'reject-owned-turn second'));
    });
  }, 60_000);

  it('holds the acknowledgement until release, then accepts later matches at once', async () => {
    if (exempt('hold-ack')) return;
    const holdAck = control({ kind: 'hold-ack', match: 'delay-owned-ack' });
    await seam(runner, holdAck.path, async (session, wire) => {
      const input = send(session, 'mock:agent-echo delay-owned-ack');
      await waitFor(holdAck.held);
      // bound: proves an absence; a settled acknowledgement would arrive within a few ms.
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(input.state.settled).toBe(false);
      holdAck.release();
      await input.done;
      expect(input.state.rejected).toBe(false);
      await waitFor(() => echoed(wire, 'delay-owned-ack') && turnEnds(wire) === 2);
    });
    await seam(runner, holdAck.path, async (session, wire) => {
      const input = send(session, 'mock:agent-echo delay-owned-ack');
      await input.done;
      await waitFor(() => echoed(wire, 'delay-owned-ack'));
    });
  }, 60_000);

  it('admits the input but sends no turn content until release', async () => {
    const holdResponse = control({ kind: 'hold-response', match: 'hold-owned-response' });
    await seam(runner, holdResponse.path, async (session, wire) => {
      const input = send(session, 'mock:agent-echo hold-owned-response');
      await waitFor(holdResponse.held);
      // bound: proves an absence; unheld content would arrive within a few ms.
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(echoed(wire, 'hold-owned-response')).toBe(false);
      expect(turnEnds(wire)).toBe(1);
      holdResponse.release();
      await input.done;
      expect(input.state.rejected).toBe(false);
      await waitFor(() => echoed(wire, 'hold-owned-response') && turnEnds(wire) === 2);
    });
  }, 60_000);

  for (const kind of ['reject', 'hold-ack'] as const) {
    const criterion = EXEMPT[runner]?.[kind];
    if (criterion) it(`${kind} is the named exemption ${criterion}, and the mock fails closed`, async () => {
      expect(exemptionFor(criterion, runner)?.kind).toBe('capability-absent');
      const unsupported = control({ kind, match: 'x' });
      const observation = await driveSeam(runner, 'baseline', { spec: { env: { ...ENV_BASE, CEZ_MOCK_DELIVERY_CONTROL: unsupported.path } } });
      expect(observation.v1.some(event => event.type === 'turn-end')).toBe(false);
      expect(JSON.stringify(observation)).toContain(`CEZ_MOCK_DELIVERY_CONTROL: this native mock does not support ${kind}`);
    }, 60_000);
  }

  it('fails closed on a malformed control and never completes a turn', async () => {
    const path = join(tempRoot(), 'native-delivery-control.json');
    writeFileSync(path, '{');
    const observation = await driveSeam(runner, 'baseline', { spec: { env: { ...ENV_BASE, CEZ_MOCK_DELIVERY_CONTROL: path } } });
    expect(observation.v1.some(event => event.type === 'turn-end')).toBe(false);
    expect(JSON.stringify(observation)).toContain('CEZ_MOCK_DELIVERY_CONTROL');
  }, 60_000);
});

it('fails closed on an empty control variable', async () => {
  const observation = await driveSeam('codex', 'baseline', { spec: { env: { ...ENV_BASE, CEZ_MOCK_DELIVERY_CONTROL: '' } } });
  expect(observation.v1.some(event => event.type === 'turn-end')).toBe(false);
  expect(JSON.stringify(observation)).toContain('CEZ_MOCK_DELIVERY_CONTROL');
}, 60_000);
