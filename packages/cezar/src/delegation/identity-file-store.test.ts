import { afterEach, expect, it } from 'vitest';
import { identityFileStore, installIdentityFileStore, type IdentityFileStore } from './identity-file-store.ts';
import { posixIdentityFileStore } from './posix-workspace-identity.ts';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
function onPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...platform, value });
}
afterEach(() => { Object.defineProperty(process, 'platform', platform); installIdentityFileStore(undefined); });

const fake: IdentityFileStore = {
  directory: async () => {}, read: async () => '', write: async () => {}, replace: async () => {},
};

it('uses the POSIX store on a non-Windows host with no store installed', () => {
  onPlatform('linux');
  expect(identityFileStore()).toBe(posixIdentityFileStore);
});

it('refuses to pick a store on Windows when no process entry installed one', () => {
  onPlatform('win32');
  expect(() => identityFileStore()).toThrow(/No workspace identity store is installed/);
});

it('uses the installed store on every platform', () => {
  installIdentityFileStore(fake);
  for (const value of ['linux', 'win32', 'darwin'] as const) {
    onPlatform(value);
    expect(identityFileStore()).toBe(fake);
  }
});
