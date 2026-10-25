import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readMockRecords } from './mock-records.testkit.ts';
import { ciNativeMessages, ciNativeSteers } from './workflows/waits-parity.testkit.ts';

// A read that lands while a mock appends its last record sees that line cut short
// (hearsay-tools/cezarion#1855: "Unterminated string in JSON" in a waits parity cell).
const opencodePrompt = JSON.stringify({ method: 'POST', url: '/session/s1/prompt_async', body: { parts: [{ text: 'first' }] } });
const codexSteer = JSON.stringify({ method: 'turn/steer', params: { input: [{ text: 'steer' }] } });
const partial = '{"method":"POST","url":"/session/s1/prompt_async","body":{"parts":[{"text":"sec';

describe('native mock records', () => {
  const dirs: string[] = [];
  const dir = (): string => {
    const created = mkdtempSync(join(tmpdir(), 'mock-records-'));
    dirs.push(created);
    return created;
  };
  afterEach(() => { for (const created of dirs.splice(0)) rmSync(created, { recursive: true, force: true }); });

  it('parses only the lines a mock finished writing', () => {
    const root = dir();
    writeFileSync(join(root, 'args'), `${opencodePrompt}\n${partial}`);
    expect(readMockRecords(join(root, 'args'))).toEqual([JSON.parse(opencodePrompt)]);
    writeFileSync(join(root, 'args'), `${opencodePrompt}\n`);
    expect(readMockRecords(join(root, 'args'))).toEqual([JSON.parse(opencodePrompt)]);
    expect(readMockRecords(join(root, 'missing'))).toEqual([]);
  });

  it('gives the waits parity readers the complete records while the last one is still being written', () => {
    const root = dir();
    writeFileSync(join(root, 'args'), `${opencodePrompt}\n${partial}`);
    expect(ciNativeMessages('opencode', root)).toEqual(['first']);
    writeFileSync(join(root, 'args'), `${codexSteer}\n${partial}`);
    expect(ciNativeSteers('codex', root)).toEqual(['steer']);
  });
});
