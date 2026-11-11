import { expect, it } from 'vitest';
import { POWERSHELL, powershellEnv } from './detached-process.ts';

it('drops every spelling of PSModulePath and keeps the rest of the environment', () => {
  const env = powershellEnv({ PATH: 'C:\\Windows', PSModulePath: 'C:\\pwsh7', psmodulepath: 'x', HOME: 'C:\\Users\\op' });
  expect(env).toEqual({ PATH: 'C:\\Windows', HOME: 'C:\\Users\\op' });
});

it('names Windows PowerShell 5.1', () => {
  expect(POWERSHELL).toBe('powershell.exe');
});
