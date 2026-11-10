import { vi } from 'vitest';

vi.doMock('../home/switch.ts', () => ({ REBRAND_SWITCH: true }));
await import('./automations-api.test.ts');
