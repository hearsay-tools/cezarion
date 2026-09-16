const fs = require('node:fs');

const allowlisted = [
  /^[^/]+\.md$/,
  /^docs\/(?:[^/]+\/)*[^/]+$/,
  /^\.ai\/specs\/(?:[^/]+\/)*[^/]+$/,
  /^\.ai\/analysis\/(?:[^/]+\/)*[^/]+$/,
  /^(?:AGENT_PROTOCOL|AGENTS|BACKWARD_COMPATIBILITY|CODE_REVIEW|SDLC)\.md$/,
  /^LICENSE[^/]*$/,
];

function isValidPath(path) {
  return typeof path === 'string'
    && path.length > 0
    && !path.startsWith('/')
    && !path.includes('\\')
    && !path.includes('\0')
    && !path.split('/').includes('..')
    && !path.split('/').includes('')
    && allowlisted.some((pattern) => pattern.test(path));
}

function classifyPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every(isValidPath)) {
    return 'full-matrix';
  }
  return 'docs-only';
}

function classifyJsonLines(input) {
  if (typeof input !== 'string' || input.length === 0) {
    return 'full-matrix';
  }

  const withoutFinalNewline = input.endsWith('\n') ? input.slice(0, -1) : input;
  if (withoutFinalNewline.length === 0) {
    return 'full-matrix';
  }

  const lines = withoutFinalNewline.split('\n');
  const paths = [];
  try {
    for (const line of lines) {
      const value = JSON.parse(line);
      if (typeof value !== 'string') {
        return 'full-matrix';
      }
      paths.push(value);
    }
  } catch {
    return 'full-matrix';
  }
  return classifyPaths(paths);
}

if (require.main === module) {
  process.stdout.write(`${classifyJsonLines(fs.readFileSync(0, 'utf8'))}\n`);
}

module.exports = { classifyPaths, classifyJsonLines };
