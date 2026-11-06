import { blankOnce, lineAt, type SourceRule } from './source-rule.ts';

const NAMES = '(?:watchdogStall|watchdogWritePid|waitForMockRelease|waitForRelease)';
const DEFINITION = new RegExp(`\\b(?:function\\s*\\*?\\s*|(?:const|let|var)\\s+)${NAMES}\\b`, 'g');
const PID_LITERAL = /(['"`])watchdog\.pid\1/g;

/** Stall ordering and readiness belong to the lifecycle module, never its callers. */
export const mockLifecycleBoundary: SourceRule = {
  name: 'mock-lifecycle-boundary',
  description: 'Native mocks share the no-progress stall and release wait (hearsay-tools/cezarion#1529).',
  applies: file => /^packages\/cezar\/scripts\/mock-[^/]+\.mjs$/.test(file)
    && file !== 'packages/cezar/scripts/mock-lifecycle.mjs',
  check: (_file, source) => {
    const code = blankOnce(source);
    const sites = [...code.matchAll(DEFINITION)].map(match => match.index);
    // Blanking keeps literal delimiters: reject real literals, but ignore samples in comments.
    for (const match of source.matchAll(PID_LITERAL)) {
      if (code[match.index] === match[1]) sites.push(match.index);
    }
    return sites.sort((a, b) => a - b).map(offset => ({
      line: lineAt(source, offset),
      message: 'Use mock-lifecycle.mjs for the stall, readiness pid and release wait (hearsay-tools/cezarion#1529).',
    }));
  },
};
