import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mobileMetadata, iosConfiguration } from '../../../mobile/scripts/build-metadata.mjs';
import { productIdentity } from './identity.ts';

describe('mobile build metadata', () => {
  it.each(['off', 'on'])('derives native IDs and names with switch %s', (rebrand) => {
    expect(mobileMetadata({ rebrand })).toMatchObject(productIdentity(rebrand === 'on'));
    expect(mobileMetadata({ rebrand }).finalOldApp).toBe(false);
  });
  it('keeps the checked-in Xcode configuration in sync with the release switch', () => {
    const checkedIn = readFileSync(new URL('../../../mobile/ios/ProductIdentity.xcconfig', import.meta.url), 'utf8');
    expect(checkedIn).toBe(iosConfiguration(mobileMetadata()));
  });
  it('forces old IDs for the final build and preserves the supplied store URL', () => {
    const storeUrl = 'https://apps.apple.com/app/example?id=1&campaign=$(literal)//test';
    const metadata = mobileMetadata({ rebrand: 'on', finalOldApp: true, storeUrl });
    expect(metadata).toMatchObject({ ...productIdentity(false), finalOldApp: true, storeUrl, moveDisplayName: 'Squawk' });
    const config = iosConfiguration(metadata);
    expect(config).toContain('MOBILE_FINAL_OLD_APP = true');
    expect(config).toContain('MOBILE_SWIFT_CONDITIONS = FINAL_OLD_APP');
    expect(config).toContain(`MOBILE_STORE_URL_BASE64 = ${Buffer.from(storeUrl).toString('base64')}`);
  });
  it.each(['', 'http://example.com', 'javascript:alert(1)', 'https://user:password@example.com'])('rejects a missing or unsafe store URL %s', (storeUrl) => {
    expect(() => mobileMetadata({ finalOldApp: true, storeUrl })).toThrow();
  });
  it('rejects a store URL outside the final build and invalid switch values', () => {
    expect(() => mobileMetadata({ storeUrl: 'https://example.com' })).toThrow('--final-old-app');
    expect(() => mobileMetadata({ rebrand: 'yes' })).toThrow('--rebrand');
  });
  it('exposes JSON to Gradle and fails invalid release inputs', () => {
    const script = fileURLToPath(new URL('../../../mobile/scripts/build-metadata.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--rebrand', 'on'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject(productIdentity(true));
    const invalid = spawnSync(process.execPath, [script, '--final-old-app'], { encoding: 'utf8' });
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toBe('');
  });
});
