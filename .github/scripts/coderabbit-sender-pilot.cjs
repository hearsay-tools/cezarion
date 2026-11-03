'use strict';

// Disposable NON-MERGE review scope. No runtime integration or side effects.
function pilotLabel(name) {
  const label = String(name ?? '').trim();
  return label ? `Sender pilot: ${label}` : 'Sender pilot';
}

module.exports = { pilotLabel };
