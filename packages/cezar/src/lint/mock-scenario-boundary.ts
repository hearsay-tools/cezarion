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

/** Use retained delimiters to read literal contents while ignoring comment samples. */
function literals(source: string, code: string): Array<{ offset: number; value: string; regex: boolean }> {
  const found = [];
  for (let i = 0; i < source.length; i++) {
    const delimiter = source[i]!;
    if (!['\'', '"', '`', '/'].includes(delimiter) || code[i] !== delimiter) continue;
    let j = delimiter === '/' ? regexEnd(source, i) : i + 1;
    if (j < 0) continue;
    for (; delimiter !== '/' && j < source.length; j++) {
      if (source[j] === '\\') j++;
      else if (source[j] === delimiter || delimiter !== '`' && source[j] === '\n') break;
    }
    if (source[j] !== delimiter) continue;
    found.push({ offset: i, value: source.slice(i + 1, j), regex: delimiter === '/' });
    i = j;
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
