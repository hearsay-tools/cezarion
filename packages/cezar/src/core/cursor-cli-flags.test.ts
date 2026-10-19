import { afterEach, describe, expect, it } from 'vitest';
import {
  CURSOR_DISABLE_AUTO_UPDATE, cursorArgs, noteCursorAutoUpdateFlagRejected, rejectsCursorAutoUpdateFlag,
  resetCursorAutoUpdateFlagCache,
} from './cursor-cli-flags.ts';

afterEach(() => resetCursorAutoUpdateFlagCache());

describe('Cursor auto-update flag (hearsay-tools/cezarion#1257)', () => {
  it('prefixes every launch with --disable-auto-update by default', () => {
    expect(cursorArgs('agent', ['acp'])).toEqual([CURSOR_DISABLE_AUTO_UPDATE, 'acp']);
  });
  it('recognizes only the commander rejection of this flag', () => {
    expect(rejectsCursorAutoUpdateFlag("error: unknown option '--disable-auto-update'\n")).toBe(true);
    expect(rejectsCursorAutoUpdateFlag("error: unknown option '--other'\n")).toBe(false);
    expect(rejectsCursorAutoUpdateFlag('Invalid --allowed-tools value(s): x. Expected one of: a')).toBe(false);
  });
  it('omits the flag for a binary that rejected it, and only that binary', () => {
    noteCursorAutoUpdateFlagRejected('/old/agent');
    expect(cursorArgs('/old/agent', ['--list-models'])).toEqual(['--list-models']);
    expect(cursorArgs('agent', ['--list-models'])).toEqual([CURSOR_DISABLE_AUTO_UPDATE, '--list-models']);
  });
});
