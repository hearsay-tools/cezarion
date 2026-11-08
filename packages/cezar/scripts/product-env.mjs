// Shipped probes/mocks share the product accessor. Source checkouts need no build;
// the published package contains dist/ and scripts/, without src/.
import { existsSync } from 'node:fs';

export const { productEnv } = await import(existsSync(new URL('../src/core/product-env.ts', import.meta.url))
  ? '../src/core/product-env.ts' : '../dist/core/product-env.js');
