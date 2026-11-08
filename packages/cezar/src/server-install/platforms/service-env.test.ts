import { expect, it } from 'vitest';
import { launchdRemoteEnv, systemdRemoteEnv } from './service-env.ts';

it('leaves unrelated service definitions unchanged', () => {
  expect(systemdRemoteEnv('[Service]\nExecStart=/usr/bin/other\n')).toBe('[Service]\nExecStart=/usr/bin/other\n');
  for (const xml of ['<plist/>', '<key>EnvironmentVariables</key><dict><key>PATH</key><string>/bin</string></dict>']) {
    expect(launchdRemoteEnv(xml)).toBe(xml);
  }
});

it('repairs conflicting pins once without changing other settings', () => {
  const unit = '[Service]\nEnvironment=HSQ_REMOTE=0\nEnvironment=CEZ_REMOTE=1\nEnvironment=KEEP=empty\nExecStart=/custom/run\n';
  const next = systemdRemoteEnv(unit);
  expect(next).toBe(unit.replace('Environment=HSQ_REMOTE=0\n', '').replace('Environment=CEZ_REMOTE=1\n', 'Environment=CEZ_REMOTE=1\nEnvironment=HSQ_REMOTE=1\n'));
  expect(systemdRemoteEnv(next)).toBe(next);
  const xml = '<key>EnvironmentVariables</key><dict><key>CEZ_REMOTE</key><string>1</string><key>HSQ_REMOTE</key><string>0</string><key>PATH</key><string>/custom/bin</string></dict>';
  const fixed = launchdRemoteEnv(xml);
  expect(fixed).toContain('<key>HSQ_REMOTE</key>\n      <string>1</string>');
  expect(fixed).toContain('<key>PATH</key><string>/custom/bin</string>');
  expect(launchdRemoteEnv(fixed)).toBe(fixed);
});
