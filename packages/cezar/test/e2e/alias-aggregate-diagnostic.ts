/** Patch fresh emitted modules only in the disposable package installation. */
export const aggregateNames = ['reaperCalls', 'sweeps', 'candidateListEntries', 'aliasScans', 'literalScans',
  'mapsBytes', 'mountinfoBytes', 'statBytes', 'readChargeUnits', 'aliasLines', 'literalLines', 'mountRecords',
  'evaluations', 'evaluationCandidates', 'inspectionAttempts', 'inspectionReturns', 'evaluatorRequestedUnits'] as const;

export const aggregateModule = `const values = Object.fromEntries(${JSON.stringify(aggregateNames)}.map(name => [name, 0]));
export function count(name, amount = 1) { values[name] = Math.min(2147483647, values[name] + amount); }
export function snapshot() { return { ...values }; }
`;

/** Refuse any unexpected emitted source before the caller writes any file. */
export function instrumentAggregate(sources: Record<string, string>): Record<string, string> {
  const replacements: Record<string, [string, string][]> = {
    'linux-alias-model.js': [
      ['return lines.map(line => {\n        budget.spend();', 'return lines.map(line => {\n        cezCount("mountRecords");\n        budget.spend();'],
      ['const result = [];\n    for (const line of lines) {\n        budget.spend();', 'const result = [];\n    for (const line of lines) {\n        cezCount("aliasLines");\n        budget.spend();'],
    ],
    'linux-mapped-holders.js': [
      ["for (const line of content.split('\\n')) {\n        budget?.spend(1 + roots.length);", "for (const line of content.split('\\n')) {\n        cezCount('literalLines');\n        budget?.spend(1 + roots.length);"],
      ['export function mappedHolder(pid, roots, budget) {', 'export function mappedHolder(pid, roots, budget) {\n    cezCount("literalScans");'],
    ],
    'linux-alias-scan.js': [
      ['export function scanAliases(pid, token, attempt, onConfirmed, onCandidate) {', 'export function scanAliases(pid, token, attempt, onConfirmed, onCandidate) {\n    cezCount("aliasScans");'],
      ['const matches = new Map();\n    for (const candidate of candidates) {\n        budget.spend(257 + roots.length);', 'cezCount("evaluations");\n    cezCount("evaluationCandidates", candidates.length);\n    const matches = new Map();\n    for (const candidate of candidates) {\n        cezCount("evaluatorRequestedUnits", 257 + roots.length);\n        budget.spend(257 + roots.length);'],
      ['info = inspect(root.path, candidate.path);', 'cezCount("inspectionAttempts");\n            info = inspect(root.path, candidate.path);\n            cezCount("inspectionReturns");'],
    ],
    'linux-proc-evidence.js': [
      ['const length = readSync(fd, chunk, 0, chunk.length, null);', 'const length = readSync(fd, chunk, 0, chunk.length, null);\n            if (path.endsWith("/maps")) cezCount("mapsBytes", length);\n            else if (path.endsWith("/mountinfo")) cezCount("mountinfoBytes", length);\n            else if (path.endsWith("/stat")) cezCount("statBytes", length);'],
      ['budget.spend(Math.ceil(length / 256));', 'cezCount("readChargeUnits", Math.ceil(length / 256));\n            budget.spend(Math.ceil(length / 256));'],
    ],
    'destroy-holders.js': [
      ['export async function reapDestroyHolders(paths, assertCurrent, timeoutMs = 3_000, retention, attemptBudget) {', 'export async function reapDestroyHolders(paths, assertCurrent, timeoutMs = 3_000, retention, attemptBudget) {\n    cezCount("reaperCalls");'],
      ['const budget = process.platform === \'linux\' && retention ? attemptBudget ?? new AliasWorkBudget() : undefined;\n    for (;;) {', 'const budget = process.platform === \'linux\' && retention ? attemptBudget ?? new AliasWorkBudget() : undefined;\n    for (;;) {\n        cezCount("sweeps");'],
      ['const candidates = aliases ? linuxCandidates(budget) : undefined;', 'const candidates = aliases ? linuxCandidates(budget) : undefined;\n        if (candidates) cezCount("candidateListEntries", candidates.length);'],
    ],
  };
  const output: Record<string, string> = {};
  for (const [file, edits] of Object.entries(replacements)) {
    let source = sources[file];
    if (typeof source !== 'string') throw new Error(`aggregate diagnostic missing ${file}`);
    for (const [marker, replacement] of edits) {
      if (source.split(marker).length !== 2) throw new Error(`aggregate diagnostic marker changed: ${file}`);
      source = source.replace(marker, replacement);
    }
    output[file] = `import { count as cezCount } from './cez-alias-aggregate.js';\n` + source;
  }
  output['cez-alias-aggregate.js'] = aggregateModule;
  return output;
}
