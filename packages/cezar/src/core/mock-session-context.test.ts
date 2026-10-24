import { describe, expect, it } from 'vitest';
import {
  rawMessage,
  stripCommandMessage,
  withoutSessionContext,
  withoutSessionContextBody,
  withoutSessionContextParts,
} from '../../scripts/mock-session-context.mjs';

// hearsay-tools/cezarion#1584: the native mocks match scenarios on the opening message without
// its session-context blocks, whose handoff repeats the task's `mock:` tokens.
const PREFIX = '<cezar-context id="handoff" source="/runs/r.handoff.md">\n## Goal\n\nmock:ask\n</cezar-context>\n\n' +
  '<cezar-context id="vision">\nVision\n</cezar-context>\n\n---\n\n';

describe('mock session-context stripping', () => {
  it('removes the leading blocks and their separator', () => {
    expect(withoutSessionContext(`${PREFIX}mock:done`)).toBe('mock:done');
  });

  it('keeps in-thread system instructions in front', () => {
    expect(withoutSessionContext(`System text\n\n---\n\n${PREFIX}Keep working.`)).toBe('System text\n\n---\n\nKeep working.');
  });

  it('leaves text without a prefix, or with a tag that is not a prefix, unchanged', () => {
    for (const text of [
      'mock:done',
      'quote <cezar-context id="x">\nbody\n</cezar-context>\n\n---\n\nrest',
      '<cezar-context id="x">\nunterminated',
      '<cezar-context id="x">\nbody\n</cezar-context>\n\nno separator',
    ]) expect(withoutSessionContext(text)).toBe(text);
    expect(withoutSessionContext(undefined)).toBeUndefined();
  });

  it('strips an OpenCode JSON body, whose quotes are escaped, and keeps other bodies', () => {
    const body = JSON.stringify({ parts: [{ type: 'text', text: `${PREFIX}mock:done` }], agent: 'build' });
    expect(JSON.parse(withoutSessionContextBody(body))).toEqual({ parts: [{ type: 'text', text: 'mock:done' }], agent: 'build' });
    for (const other of ['', '{"title":"cezar task"}', '<cezar-context id= not json', JSON.stringify({ text: '<cezar-context id=' })]) {
      expect(withoutSessionContextBody(other)).toBe(other);
    }
  });

  it('strips native input parts and keeps non-text parts', () => {
    const image = { type: 'image', url: 'x' };
    expect(withoutSessionContextParts([{ type: 'text', text: `${PREFIX}go` }, image])).toEqual([{ type: 'text', text: 'go' }, image]);
    expect(withoutSessionContextParts(undefined)).toBeUndefined();
  });

  it('strips an RPC command for matching and keeps the raw text for the recording', () => {
    const command = stripCommandMessage({ type: 'prompt', message: `${PREFIX}mock:done` });
    expect(command.message).toBe('mock:done');
    expect(rawMessage(command)).toBe(`${PREFIX}mock:done`);
    const plain = stripCommandMessage({ type: 'abort' });
    expect(rawMessage({ message: 'untouched' })).toBe('untouched');
    expect(plain).toEqual({ type: 'abort' });
  });
});
