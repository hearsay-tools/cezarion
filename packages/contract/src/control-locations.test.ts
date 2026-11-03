import { describe, expect, it } from 'vitest';
import { controlLocation } from './control-locations.ts';

describe('control location text', () => {
  it('preserves navigation labels and separators', () => {
    expect(controlLocation('general')).toBe('Settings → General');
    expect(controlLocation('webhooks')).toBe('Settings → General → Webhooks');
    expect(controlLocation('providers')).toBe('Settings → Agents → Providers');
    expect(controlLocation('projects')).toBe('Settings → Projects');
    expect(controlLocation('sidebar')).toBe('Settings → Sidebar');
    expect(controlLocation('worktrees', ' › ')).toBe('Settings › Worktrees');
  });
});
