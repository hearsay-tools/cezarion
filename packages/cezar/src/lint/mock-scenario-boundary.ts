import { regexEnd } from './blank.ts';
import { blankOnce, lineAt, type SourceRule } from './source-rule.ts';

const SHARED = ['agent-echo', 'autonomous', 'cezar-ask', 'cezar-done', 'cezar-tool', 'ci-wait',
  'crash-stderr', 'deferred-turn-start', 'hold', 'multi-pr-refs', 'no-progress', 'gate-prompt-ack',
  'silent-tail', 'tool-tail', 'turn-messages', 'ack-only', 'busy-progress', 'provider-error',
  'resume-cezar-done', 'steer-tool', 'steer-late', 'subagent-after-park', 'cezar-wait'];
const TOKEN = new RegExp(`mock:(?:${SHARED.join('|')})(?=$|[^a-z0-9]|-)`);
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

function namesShared(value: string, regex: boolean): boolean {
  if (TOKEN.test(value)) return true;
  // A regex may group alternatives after the shared prefix: /mock:(hold|no-progress)/.
  return regex && value.includes('mock:') && SHARED.some(name => new RegExp(`\\b${name}\\b`).test(value));
}

export const mockScenarioBoundary: SourceRule = {
  name: 'mock-scenario-boundary',
  description: 'Shared mock scripts belong to mock-scenario.mjs (hearsay-tools/cezarion#2769).',
  applies: file => /^packages\/cezar\/scripts\/mock-[^/]+\.mjs$/.test(file)
    && file !== 'packages/cezar/scripts/mock-scenario.mjs',
  check: (_file, source) => {
    const code = blankOnce(source);
    if (!importsScenario(source, code)) return [];
    return literals(source, code).filter(literal => namesShared(literal.value, literal.regex)).map(literal => ({
      line: lineAt(source, literal.offset),
      message: 'Use mock-scenario.mjs for shared scenario selection and scripts (hearsay-tools/cezarion#2769).',
    }));
  },
};
