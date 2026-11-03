import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { RESTART_GROUPS } from './worker-restart-parity.testkit.ts';

it('runs each complete native-runner restart family in exactly one file', () => {
 const registrations = readdirSync(new URL('.', import.meta.url))
  .filter(name => name.startsWith('worker-restart-') && name.endsWith('-parity.test.ts'))
  .flatMap(name => { return [...readFileSync(new URL(name, import.meta.url), 'utf8').matchAll(/registerRestartGroup\('([^']+)'\)/g)].map(match => match[1]); });
 expect(registrations.sort()).toEqual(Object.keys(RESTART_GROUPS).sort());
 expect(Object.values(RESTART_GROUPS).flat().sort()).toEqual(['destroy-absent', 'destroy-incomplete', 'same-boot-crash-lock', 'starting-proof']);
});
