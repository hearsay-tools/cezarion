import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryControl, readDeliveryControl, type DeliveryControlOptions } from '../../scripts/mock-delivery-control.mjs';

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
    await delivery.holdResponse('other');
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
