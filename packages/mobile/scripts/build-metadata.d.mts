import type { ProductIdentity } from '../../cezar/src/home/identity.ts';

type MobileMetadata = ProductIdentity & { finalOldApp: boolean; storeUrl: string; moveDisplayName: string };
export function mobileMetadata(options?: { rebrand?: string | undefined; finalOldApp?: boolean | undefined; storeUrl?: string | undefined }): MobileMetadata;
export function iosConfiguration(metadata: MobileMetadata): string;
