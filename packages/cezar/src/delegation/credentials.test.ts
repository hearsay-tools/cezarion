import { afterEach, describe, expect, it } from 'vitest';
import { CredentialRegistry } from './credentials.ts';

const registry = new CredentialRegistry();
afterEach(() => registry.revoke('root'));

describe('CredentialRegistry', () => {
  it('issues independent 32-byte base64url credentials, scoped to registry identity', () => {
    const other = new CredentialRegistry();
    const token = registry.issue('project', 'root', 'generation-1');
    const second = other.issue('project', 'root', 'generation-1');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(second).not.toBe(token);
    expect(registry.authenticate(second)).toBeUndefined();
    const caller = registry.authenticate(token)!;
    expect(caller).toMatchObject({ projectId: 'project', runId: 'root', generation: 'generation-1' });
    expect(Object.isFrozen(caller)).toBe(true);
    expect(() => Object.assign(caller, { runId: 'forged' })).toThrow();
    expect(JSON.stringify(registry)).not.toContain(token);
    other.close();
  });

  it('rejects unknown, empty and altered tokens without exposing identity', () => {
    const token = registry.issue('project', 'root', 'generation-1');
    for (const wrong of ['', 'root', `${token}x`, token.slice(1), ` ${token}`]) {
      expect(registry.authenticate(wrong)).toBeUndefined();
    }
  });

  it('rotates the previous run credentials while leaving other runs independent', () => {
    const first = registry.issue('project', 'root', 'generation-1');
    const peer = registry.issue('project', 'peer', 'generation-1');
    const next = registry.issue('project', 'root', 'generation-2');
    expect(registry.authenticate(first)).toBeUndefined();
    expect(registry.authenticate(next)).toMatchObject({ generation: 'generation-2' });
    expect(registry.authenticate(peer)).toMatchObject({ runId: 'peer' });
    registry.revoke('peer');
  });

  it('revokes all run credentials idempotently', () => {
    const first = registry.issue('project', 'root', 'generation-1');
    const second = registry.issue('project', 'root', 'generation-1');
    registry.revoke('root');
    registry.revoke('root');
    expect(registry.authenticate(first)).toBeUndefined();
    expect(registry.authenticate(second)).toBeUndefined();
  });

  it('close revokes every credential and prevents reuse of the closed registry', () => {
    const local = new CredentialRegistry();
    const tokens = ['root', 'worker'].map(id => local.issue('project', id, 'generation'));
    local.close();
    local.close();
    for (const token of tokens) expect(local.authenticate(token)).toBeUndefined();
    expect(() => local.issue('project', 'root', 'new-generation')).toThrow();
    expect(new CredentialRegistry().authenticate(tokens[0]!)).toBeUndefined();
  });
});
