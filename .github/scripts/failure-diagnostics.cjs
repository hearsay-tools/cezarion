const { createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
const stripAnsi = text => String(text).replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');

// Applied to metadata as well as logs. Render the result as indented text, never
// interpolate it into code, shell, action commands, HTML or Markdown links.
function redactedLines(value, label) {
  return value.split('\n').map(line => (line.match(/^\d{4}-\d\d-\d\dT\S+ /)?.[0] || '') + label).join('\n');
}
function redact(text) {
  return stripAnsi(text)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, value => redactedLines(value, '[REDACTED PRIVATE KEY]'))
    .replace(/^.*(?:authorization|cookie|password|passwd|secret|api[_-]?key|token)["']?\s*[:=][ \t]*(?:\r?\n[ \t]*)?[^\r\n]*$/gim, value => redactedLines(value, '[REDACTED CREDENTIAL LINE]'))
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|npm_[A-Za-z0-9]+|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9_-]+)\b/g, '[REDACTED TOKEN]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s<>"']+/gi, value => {
      try { const url = new URL(value); return `${url.protocol}//${url.hostname}${url.pathname}`; } catch { return '[REDACTED URL]'; }
    })
    .replace(/\b[A-Za-z0-9_+/=-]{40,}\b/g, '[REDACTED LONG VALUE]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/@/g, '@\u200b').replace(/</g, '‹').replace(/>/g, '›')
    .replace(/::/g, ':\u200b:').replace(/`/g, 'ˋ');
}
function sanitize(text) { return redact(text).slice(0, 4000); }
function stageFor(step) {
  if (/version-bump|github release|workflow summary/i.test(step.name)) return 'finalization';
  if (/^publish/i.test(step.name)) return 'publishing';
  if (/test|unit|suite|verif|typecheck|build/i.test(step.name)) return 'verification';
  return 'setup';
}
function stepLines(log, step) {
  const lines = stripAnsi(log || '').split(/\r?\n/);
  const start = Date.parse(step.started_at), end = Date.parse(step.completed_at) + 999;
  let inStep = false;
  const timestamped = lines.some(line => /^\d{4}-\d\d-\d\dT/.test(line));
  return lines.filter(line => {
    if (!timestamped) return true;
    const stamp = line.match(/^(\d{4}-\d\d-\d\dT\S+) /);
    if (stamp) inStep = Date.parse(stamp[1]) >= start && Date.parse(stamp[1]) <= end;
    return inStep;
  }).map(line => line.replace(/^\d{4}-\d\d-\d\dT\S+ /, '').trimEnd());
}
function normalizeIdentity(text) {
  // Hash full diagnostic identity; display redaction is deliberately lossy and
  // must never collapse distinct test paths into one cause.
  return stripAnsi(text).replace(/0x[\da-f]+/gi, '<address>')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/g, '<duration>').replace(/\s+/g,' ').trim();
}
function causesForStep({run, job, step, log}) {
  const lines = stepLines(log, step);
  const safeLines = stepLines(redact(log || ''), step);
  const stage = stageFor(step);
  const tests = lines.flatMap((line, index) => {
    const match = line.match(/\bFAIL\s+(?:\S+\s+)?((?:[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?:\s+>\s+.+)?)/);
    return match ? [{key: 'test:' + normalizeIdentity(match[1]), title: match[1], index}] : [];
  });
  for (let i=0; i<tests.length; i++) {
    const diagnostic = lines.slice(tests[i].index+1, tests[i+1]?.index ?? lines.length)
      .find(line => /\b\w*Error:/.test(line));
    tests[i].testKey = tests[i].key;
    if (diagnostic) tests[i].key += ':' + normalizeIdentity(diagnostic);
    tests[i].hasDiagnostic = Boolean(diagnostic);
  }
  const errors = tests.length ? [] : lines.flatMap((line, index) => {
    if (!/(?:\b\w*Error:|npm (?:ERR!|error) |##\[error\])/.test(line)) return [];
    if (/Process completed with exit code|command failed|exit status/i.test(line)) return [];
    const normalized = normalizeIdentity(line);
    // Generic error code lines alone cannot distinguish unrelated causes.
    if (/^(?:npm (?:ERR!|error) code \w+|\[REDACTED.*\])$/.test(normalized)) return [];
    return [{key: `${stage}:${normalizeIdentity(step.name)}:${normalized}`, title: normalized, index}];
  }).slice(0, 1);
  const found = tests.length ? tests.filter(item => item.hasDiagnostic || !tests.some(other => other.testKey === item.testKey && other.hasDiagnostic)) : errors;
  if (!found.length) return [{signature: hash(`unknown:${run.id}:${run.run_attempt}:${job.id}:${step.number}`), title:`${stage} failure in ${sanitize(step.name)}`, stage, excerpt:sanitize('Logs unavailable or no recognizable failure diagnostic. Inspect the linked job and failed step.\n' + safeLines.slice(-30).join('\n'))}];
  const unique = [...new Map(found.map(item => [item.key,item])).values()];
  return unique.map(item => ({signature:hash(item.key), title:sanitize(item.title).slice(0,180), stage, excerpt:sanitize(safeLines.slice(item.index, Math.min(item.index+30, found.find(next => next.index > item.index)?.index ?? Infinity)).join('\n'))}));
}
module.exports = {causesForStep, sanitize, hash};
