import { describe, expect, it } from 'vitest';
import { resolveArchiveOnMerge } from './archive-on-merge-setting.ts';

describe('archive on merge preference', () => {
  it('requires exact opt-in and lets explicit false override every inherited true', () => {
    for (const value of [undefined, '', '0', 'true', 'yes']) {
      expect(resolveArchiveOnMerge({}, {}, { CEZ_ARCHIVE_ON_MERGE: value })).toEqual({ enabled: false, source: 'default' });
    }
    expect(resolveArchiveOnMerge({}, {}, { CEZ_ARCHIVE_ON_MERGE: '1' })).toEqual({ enabled: true, source: 'environment' });
    expect(resolveArchiveOnMerge({}, { archiveOnMerge: false }, { CEZ_ARCHIVE_ON_MERGE: '1' })).toEqual({ enabled: false, source: 'global' });
    expect(resolveArchiveOnMerge({ archiveOnMerge: false }, { archiveOnMerge: true })).toEqual({ enabled: false, source: 'project' });
    expect(resolveArchiveOnMerge({ archiveOnMerge: true }, { archiveOnMerge: false })).toEqual({ enabled: true, source: 'project' });
  });
});
