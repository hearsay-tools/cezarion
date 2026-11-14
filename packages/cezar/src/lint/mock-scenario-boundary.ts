import type { RunnerId } from '../core/agent-runner.ts';
import { regexEnd } from './blank.ts';
import { blankOnce, lineAt, type SourceRule } from './source-rule.ts';

/** Exhaustive runner keys keep a new backend from bypassing the import guard. */
export const RUNNER_MOCKS = {
  claude: 'mock-claude.mjs',
  codex: 'mock-codex-app-server.mjs',
  opencode: 'mock-opencode-serve.mjs',
  pi: 'mock-pi-rpc.mjs',
  cursor: 'mock-cursor-print.mjs',
  omp: 'mock-omp-rpc.mjs',
} satisfies Record<RunnerId, string>;
const REQUIRED_MOCKS = new Set(Object.values(RUNNER_MOCKS).map(name => `packages/cezar/scripts/${name}`));

const SHARED = ['agent-echo', 'autonomous', 'cezar-ask', 'cezar-done', 'cezar-tool', 'ci-wait',
  'crash-stderr', 'deferred-turn-start', 'hold', 'multi-pr-refs', 'no-progress', 'gate-prompt-ack',
  'silent-tail', 'turn-messages', 'ack-only', 'busy-progress', 'provider-error',
  'resume-cezar-done', 'steer-tool', 'steer-late', 'subagent-after-park', 'cezar-wait'];
const TOKEN = /mock:([a-z0-9-]+)/g;
const NATIVE_TOKENS = new Set([
  'provider-error-early', // OpenCode rejects before creating an assistant message.
  'crash-stderr-pre-ack', // Codex and OpenCode crash before native acknowledgement.
  'no-progress-ack-only', // Codex holds its native acknowledgement without a turn.
]);
const FILE_NATIVE_TOKENS: Readonly<Record<string, readonly string[]>> = {
  // Cursor print owns per-turn ask reply timing; the module does not own this modifier.
  'packages/cezar/scripts/mock-cursor-print.mjs': ['cezar-ask-reply-late'],
  // Codex's native requestUserInput reply consumes this flag, outside shared scenarios.
  'packages/cezar/scripts/mock-codex-app-server.mjs': ['resume-cezar-done'],
  // OpenCode's native question reply consumes this flag, outside shared scenarios.
  'packages/cezar/scripts/mock-opencode-serve.mjs': ['resume-cezar-done'],
};
const IMPORT = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)(['"])[^'"\n]*mock-scenario\.mjs\1/g;

function importsScenario(source: string, code: string): boolean {
  return [...source.matchAll(IMPORT)].some(match => code[match.index] === source[match.index]);
}

interface Literal { offset: number; value: string; regex: boolean }

/** Blanked code retains braces, including nested template substitutions, but no comment braces. */
function afterSubstitution(code: string, start: number): number {
  let depth = 1;
  let i = start;
  for (; i < code.length && depth; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
  }
  return i;
}

function templateParts(source: string, code: string, start: number): { parts: Literal[]; end: number } {
  const parts: Literal[] = [];
  let segment = start + 1;
  let i = segment;
  for (; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue; }
    if (source[i] === '`') break;
    if (code.slice(i, i + 2) !== '${') continue;
    parts.push({ offset: segment, value: source.slice(segment, i), regex: false });
    i = afterSubstitution(code, i + 2);
    segment = i;
    i--;
  }
  parts.push({ offset: segment, value: source.slice(segment, i), regex: false });
  return { parts, end: i };
}

function literalEnd(source: string, start: number, delimiter: string): number {
  if (delimiter === '/') return regexEnd(source, start);
  let i = start + 1;
  for (; i < source.length; i++) {
    if (source[i] === '\\') i++;
    else if (source[i] === delimiter || source[i] === '\n') break;
  }
  return source[i] === delimiter ? i : -1;
}

/** Template text and substitution code stay separate; comments in either code scope stay ignored. */
function literals(source: string, code: string): Literal[] {
  const found: Literal[] = [];
  const templateEnds = new Set<number>();
  for (let i = 0; i < source.length; i++) {
    const delimiter = source[i]!;
    if (!['\'', '"', '`', '/'].includes(delimiter) || code[i] !== delimiter || templateEnds.has(i)) continue;
    if (delimiter === '`') {
      const template = templateParts(source, code, i);
      templateEnds.add(template.end);
      found.push(...template.parts);
      continue;
    }
    const end = literalEnd(source, i, delimiter);
    if (end < 0) continue;
    found.push({ offset: i, value: source.slice(i + 1, end), regex: delimiter === '/' });
    i = end;
  }
  return found;
}

function sharedToken(file: string, token: string): boolean {
  if (NATIVE_TOKENS.has(token) || FILE_NATIVE_TOKENS[file]?.includes(token)) return false;
  return SHARED.some(name => token === name || token.startsWith(`${name}-`));
}

/** Scan one balanced group; escaped characters and classes cannot close it. */
function groupEnd(value: string, start: number): number {
  let depth = 1;
  let inClass = false;
  for (let i = start; i < value.length; i++) {
    const char = value[i];
    if (char === '\\') { i++; continue; }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (!inClass) {
      if (char === '(') depth++;
      else if (char === ')' && --depth === 0) return i;
    }
  }
  return value.length;
}

function groupedShared(file: string, value: string): boolean {
  let start = value.indexOf('mock:(');
  while (start >= 0) {
    const content = start + 'mock:('.length;
    const end = groupEnd(value, content);
    for (const word of value.slice(content, end).match(/[a-z0-9-]+/g) ?? []) {
      if (sharedToken(file, word)) return true;
    }
    start = value.indexOf('mock:(', end + 1);
  }
  return false;
}

function namesShared(file: string, value: string, regex: boolean): boolean {
  for (const match of value.matchAll(TOKEN)) {
    if (sharedToken(file, match[1]!)) return true;
  }
  return regex && groupedShared(file, value);
}

export const mockScenarioBoundary: SourceRule = {
  name: 'mock-scenario-boundary',
  description: 'Shared mock scripts belong to mock-scenario.mjs (hearsay-tools/cezarion#2769).',
  applies: file => /^packages\/cezar\/scripts\/mock-[^/]+\.mjs$/.test(file)
    && file !== 'packages/cezar/scripts/mock-scenario.mjs',
  check: (file, source) => {
    const code = blankOnce(source);
    if (!importsScenario(source, code)) {
      return REQUIRED_MOCKS.has(file)
        ? [{ line: 1, message: 'Runner mocks must import mock-scenario.mjs (hearsay-tools/cezarion#2774).' }]
        : [];
    }
    return literals(source, code).filter(literal => namesShared(file, literal.value, literal.regex)).map(literal => ({
      line: lineAt(source, literal.offset),
      message: 'Use mock-scenario.mjs for shared scenario selection and scripts (hearsay-tools/cezarion#2769).',
    }));
  },
};
