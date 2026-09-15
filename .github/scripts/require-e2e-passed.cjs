#!/usr/bin/env node
'use strict';

function lastE2eStatus(text) {
  const matches = [...String(text).matchAll(/^TEST_E2E_STATUS=(passed|skipped|failed)\s*$/gm)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

function main(text) {
  const status = lastE2eStatus(text);
  if (status === 'passed') return 0;
  process.stderr.write(
    `Cockpit browser E2E must pass in CI; got TEST_E2E_STATUS=${status ?? 'missing'}\n`,
  );
  return 1;
}

if (require.main === module) {
  const fs = require('node:fs');
  process.exit(main(fs.readFileSync(0, 'utf8')));
}

module.exports = { lastE2eStatus, main };
