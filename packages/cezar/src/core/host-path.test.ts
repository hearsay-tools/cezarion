import { afterEach, describe, expect, it } from 'vitest';
import { isAbsoluteHostPath } from './host-path.ts';

describe('isAbsoluteHostPath', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const onPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, 'platform', { ...platform, value });
  afterEach(() => { Object.defineProperty(process, 'platform', platform); });

  it('on Windows, accepts drive-letter and UNC paths and refuses drive-relative ones', () => {
    onPlatform('win32');
    for (const path of ['C:\\Users\\dev', 'c:/Users/dev', '\\\\server\\share\\repo']) expect(isAbsoluteHostPath(path), path).toBe(true);
    for (const path of ['C:dev', 'dev\\repo', '~/repo']) expect(isAbsoluteHostPath(path), path).toBe(false);
  });

  it('on POSIX, accepts only a leading slash', () => {
    onPlatform('linux');
    expect(isAbsoluteHostPath('/srv/repo')).toBe(true);
    for (const path of ['C:\\Users\\dev', 'c:/Users/dev', '\\\\server\\share\\repo', 'srv/repo']) expect(isAbsoluteHostPath(path), path).toBe(false);
  });
});
