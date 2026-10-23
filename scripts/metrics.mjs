#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runMetrics } from '../.ai/skills/check-code-quality/scripts/metrics.mjs';

export { runMetrics };

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runMetrics(process.argv.slice(2), {
    projects: ['server', 'contract', 'api-client', 'web'],
  });
}
