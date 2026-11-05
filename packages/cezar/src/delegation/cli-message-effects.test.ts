import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMessageCommand, runWorkerCommand } from './cli.ts';

const env = { CEZ_DELEGATION_URL: 'http://127.0.0.1:12345/api/v1/delegation', CEZ_DELEGATION_TOKEN: 'a'.repeat(43) };
describe('message CLI transport effects', () => {
  let output: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { output = vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());
  const json = () => JSON.parse(String(output.mock.calls.at(-1)?.[0]));
  const argsFor = (verb: string, id: string) => [verb, randomUUID(), 'message', '--id', id,
    ...(['reply', 'follow-up'].includes(verb) ? ['--request-id', randomUUID()] : [])];

  for (const verb of ['request', 'progress', 'follow-up', 'reply']) {
    it.each(['lost', 'invalid-json', 'invalid-receipt'])(`reports unknown acceptance for ${verb} after a %s response without resending`, async failure => {
      const id = randomUUID();
      const args = argsFor(verb, id);
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        if (failure === 'lost') throw Error('response lost');
        return new Response(failure === 'invalid-json' ? '{' : JSON.stringify({ secret: 'invalid' }));
      });
      expect(await runMessageCommand(args, env)).toBe(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).id).toBe(id);
      expect(json()).toMatchObject({ code: 'unavailable_transport', error: 'Delegation transport failed or returned an invalid response', effect: 'unknown', messageId: id });
      expect(json().instruction).toContain(`--id ${id}`);
      expect(json().instruction).toMatch(/exact same command/i);
      expect(json().instruction).toMatch(/unchanged/i);
    });
  }
  it.each(['request', 'progress', 'follow-up', 'reply'])('does not claim unknown acceptance before %s dispatch', async verb => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const args = argsFor(verb, randomUUID());
    expect(await runMessageCommand(args, {})).toBe(1);
    expect(json()).toEqual({ code: 'unavailable_transport', error: 'Delegation session is unavailable' });
    expect(await runMessageCommand(argsFor(verb, 'not-a-uuid'), env)).toBe(1);
    expect(json()).toMatchObject({ code: 'invalid_input' });
    expect(json()).not.toHaveProperty('effect');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves a valid service rejection without uncertain acceptance', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 'incompatible_state', error: 'Cannot reply to your own request' }), { status: 409 }));
    expect(await runMessageCommand(argsFor('reply', randomUUID()), env)).toBe(1);
    expect(json()).toEqual({ code: 'incompatible_state', error: 'Cannot reply to your own request' });
  });
  it('keeps unrelated transport errors unchanged', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('response lost'));
    expect(await runWorkerCommand(['inspect', randomUUID()], env)).toBe(1);
    expect(json()).toEqual({ code: 'unavailable_transport', error: 'Delegation transport failed or returned an invalid response' });
    expect(await runMessageCommand(['conversation', randomUUID()], env)).toBe(1);
    expect(json()).not.toHaveProperty('effect');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
