import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TOOL_GRANT_KINDS, type AgentEvent, type RunnerId, type ToolGrant } from './agent-runner.ts';
import { driveSeam } from './harness-parity.testkit.ts';
import { allowedToolsForStep } from '../workflows/types.ts';

/**
 * The Tool-list kinds case table (AGENTS.md § Case tables) as cells on every runner's native
 * mock wire (hearsay-tools/cezarion#1810). Each case is one input kind the table requires, as the
 * `ToolGrant` cezar resolves for it. Claude, pi and omp pin the tool flags their mock records;
 * the runners that cannot restrict tools must record exactly what the unset case records.
 */
export type ToolGrantCaseId =
  | 'unset'
  | 'step-default'
  | 'inherited'
  | 'explicit-copy'
  | 'extra-built-in'
  | 'extra-mcp'
  | 'narrowed'
  | 'empty'
  | 'bash-allowlist'
  | 'unset-bash-allowlist';

export type ToolGrantCase = {
  readonly id: ToolGrantCaseId;
  readonly name: string;
  readonly grant: (backend: RunnerId) => ToolGrant;
  /** omp refuses an MCP name its settings do not register; the mock reads them from here. */
  readonly env?: Readonly<Record<string, string>>;
};

const stepDefault = (backend: RunnerId): string[] => allowedToolsForStep(undefined, backend);

export const TOOL_GRANT_CASES: readonly ToolGrantCase[] = [
  { id: 'unset', name: 'TG1 an unset grant', grant: () => ({ kind: 'unset' }) },
  { id: 'step-default', name: 'TG2 the step default', grant: backend => ({ kind: 'step-default', tools: stepDefault(backend) }) },
  {
    id: 'inherited',
    name: 'TG3 a list inherited from another runner\'s default',
    grant: backend => ({ kind: 'inherited', tools: stepDefault(backend === 'claude' ? 'pi' : 'claude') }),
  },
  { id: 'explicit-copy', name: 'TG4 a hand-written copy of the default', grant: backend => ({ kind: 'explicit', tools: stepDefault(backend) }) },
  { id: 'extra-built-in', name: 'TG5 the default plus a built-in', grant: backend => ({ kind: 'explicit', tools: [...stepDefault(backend), 'WebFetch'] }) },
  {
    id: 'extra-mcp',
    name: 'TG6 the default plus an mcp__ name',
    grant: backend => ({ kind: 'explicit', tools: [...stepDefault(backend), 'mcp__docs__search'] }),
    env: { CEZ_MOCK_OMP_MCP_TOOLS: 'mcp__docs_search' },
  },
  { id: 'narrowed', name: 'TG7 a narrowed list', grant: () => ({ kind: 'explicit', tools: ['Read', 'Grep'] }) },
  { id: 'empty', name: 'TG8 an empty list', grant: () => ({ kind: 'explicit', tools: [] }) },
  {
    id: 'bash-allowlist',
    name: 'TG9 the step default with a bashAllowlist',
    grant: backend => ({ kind: 'step-default', tools: stepDefault(backend), bashAllowlist: ['git status'] }),
  },
  { id: 'unset-bash-allowlist', name: 'TG10 an unset grant with a bashAllowlist', grant: () => ({ kind: 'unset', bashAllowlist: ['git status'] }) },
];

const CEZAR_TOOLS = ['cezar_wait', 'cezar_ask', 'cezar_cancel_wait', 'cezar_done'];
const DESCRIPTOR = { name: 'cezar_ci_probe', command: 'node', args: ['/installed/ci-wait/mcp.js'] };
const CLAUDE_CEZAR = CEZAR_TOOLS.map(tool => `mcp__${DESCRIPTOR.name}__${tool}`).join(',');
const CEZAR = CEZAR_TOOLS.join(',');

/** The flags that carry tool access on each wire that has them; `--extension` keeps its basename. */
const TOOL_FLAGS: Partial<Record<RunnerId, { readonly values: readonly string[]; readonly switches: readonly string[] }>> = {
  claude: { values: ['--allowedTools', '--disallowedTools'], switches: [] },
  pi: { values: ['--extension', '--tools', '--cezar-builtin-tools', '--exclude-tools'], switches: ['--no-tools', '--no-builtin-tools'] },
  omp: { values: ['--extension', '--tools'], switches: ['--no-tools'] },
};

const PI_EXTENSIONS = ['--extension', 'pi-retry-degraded-service.mjs', '--extension', 'pi-project-skills.mjs', '--extension', 'pi-ci-wait.mjs'];
const piDefault = (builtins: string) => [...PI_EXTENSIONS, '--no-builtin-tools', '--extension', 'pi-default-tools.mjs', '--cezar-builtin-tools', builtins];
const PI_DEFAULT = 'read,edit,write,grep,find,bash,subagent,subagent_supervisor,subagent_wait';
const OMP_EXTENSIONS = ['--extension', 'omp-ci-wait.mjs'];
const OMP_DEFAULT = 'read,edit,write,grep,glob,bash,todo,lsp,ast_edit,task,wait';
const CLAUDE_DEFAULT = 'Read,Edit,Write,Grep,Glob,Bash';

/** A runner that cannot restrict tools sends each case exactly as it sends the unset one. */
const SAME_AS_UNSET = 'same as unset';
type Expected = readonly string[] | typeof SAME_AS_UNSET;
const IGNORED = Object.fromEntries(TOOL_GRANT_CASES.map(entry => [entry.id, SAME_AS_UNSET])) as Record<ToolGrantCaseId, Expected>;

/** Today's flags. A gap a case shows stays pinned until its issue changes it. */
const EXPECTED: Readonly<Record<RunnerId, Readonly<Record<ToolGrantCaseId, Expected>>>> = {
  claude: {
    'unset': [],
    'step-default': ['--allowedTools', `${CLAUDE_DEFAULT},${CLAUDE_CEZAR}`],
    'inherited': ['--allowedTools', `${CLAUDE_DEFAULT},Subagent,SubagentSupervisor,SubagentWait,${CLAUDE_CEZAR}`],
    'explicit-copy': ['--allowedTools', `${CLAUDE_DEFAULT},${CLAUDE_CEZAR}`],
    'extra-built-in': ['--allowedTools', `${CLAUDE_DEFAULT},WebFetch,${CLAUDE_CEZAR}`],
    'extra-mcp': ['--allowedTools', `${CLAUDE_DEFAULT},mcp__docs__search,${CLAUDE_CEZAR}`],
    'narrowed': ['--allowedTools', `Read,Grep,${CLAUDE_CEZAR}`],
    // An empty list sends no allowlist, so it grants what an unset one does (hearsay-tools/cezarion#1849).
    'empty': [],
    'bash-allowlist': ['--allowedTools', `Read,Edit,Write,Grep,Glob,Bash(git status:*),${CLAUDE_CEZAR}`],
    'unset-bash-allowlist': [],
  },
  pi: {
    'unset': PI_EXTENSIONS,
    'step-default': piDefault(PI_DEFAULT),
    'inherited': piDefault('read,edit,write,grep,find,bash'),
    // The copy takes the default path, which leaves every MCP and extension tool on (hearsay-tools/cezarion#1417).
    'explicit-copy': piDefault(PI_DEFAULT),
    'extra-built-in': [...PI_EXTENSIONS, '--tools', `${PI_DEFAULT},webfetch,${CEZAR}`],
    'extra-mcp': [...PI_EXTENSIONS, '--tools', `${PI_DEFAULT},mcp__docs__search,${CEZAR}`],
    'narrowed': [...PI_EXTENSIONS, '--tools', `read,grep,${CEZAR}`],
    'empty': [...PI_EXTENSIONS, '--tools', CEZAR],
    'bash-allowlist': [...PI_EXTENSIONS, '--tools', `read,edit,write,grep,find,subagent,subagent_supervisor,subagent_wait,${CEZAR}`],
    'unset-bash-allowlist': PI_EXTENSIONS,
  },
  // `--tools` filters OMP's built-ins only: MCP and extension tools stay callable (hearsay-tools/cezarion#1357).
  omp: {
    'unset': OMP_EXTENSIONS,
    'step-default': [...OMP_EXTENSIONS, '--tools', `${OMP_DEFAULT},${CEZAR}`],
    'inherited': [...OMP_EXTENSIONS, '--tools', `read,edit,write,grep,glob,bash,${CEZAR}`],
    'explicit-copy': [...OMP_EXTENSIONS, '--tools', `${OMP_DEFAULT},${CEZAR}`],
    // OMP has no WebFetch; the runner drops it with a note.
    'extra-built-in': [...OMP_EXTENSIONS, '--tools', `${OMP_DEFAULT},${CEZAR}`],
    'extra-mcp': [...OMP_EXTENSIONS, '--tools', `${OMP_DEFAULT},mcp__docs_search,${CEZAR}`],
    'narrowed': [...OMP_EXTENSIONS, '--tools', `read,grep,${CEZAR}`],
    'empty': [...OMP_EXTENSIONS, '--no-tools'],
    'bash-allowlist': [...OMP_EXTENSIONS, '--tools', `read,edit,write,grep,glob,todo,lsp,ast_edit,task,wait,${CEZAR}`],
    'unset-bash-allowlist': [...OMP_EXTENSIONS, '--tools', `read,edit,eval,glob,grep,task,wait,todo,web_search,write,${CEZAR}`],
  },
  codex: IGNORED,
  opencode: IGNORED,
  cursor: IGNORED,
};

function toolFlags(backend: RunnerId, argv: readonly string[]): string[] {
  const flags = TOOL_FLAGS[backend];
  if (!flags) return [];
  return argv.flatMap((arg, index) => {
    if (flags.switches.includes(arg)) return [arg];
    if (!flags.values.includes(arg)) return [];
    const value = argv[index + 1] ?? '';
    return [arg, arg === '--extension' ? basename(value) : value];
  });
}

/** The mock's record of what reached it: argv or requests, then stdin where hooked. Cursor
 *  print writes its plugin into a new temp dir per session, so that name is masked. */
function readRecording(dir: string, name: string): string[] {
  return [`${name}.args.ndjson`, `${name}.stdin.ndjson`].flatMap(file => {
    const path = join(dir, file);
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : [];
  }).map(line => line.replace(/cez-cursor-print-[^/"\\]+/g, 'cez-cursor-print-<session>'));
}

export function describeToolGrantParity(scope: RunnerId | 'once'): void {
  if (scope === 'once') {
    describe('harness parity — tool-grant cases', () => {
      it('the cases cover every ToolGrant kind', () => {
        expect(new Set(TOOL_GRANT_CASES.map(entry => entry.grant('claude').kind))).toEqual(new Set(TOOL_GRANT_KINDS));
      });
      it('runs each expected case exactly once', () => {
        expect(TOOL_GRANT_CASES.map(entry => entry.id).sort()).toEqual(Object.keys(EXPECTED.claude).sort());
      });
    });
    return;
  }
  const backend = scope;
  describe(`harness parity — ${backend} tool-grant cases (hearsay-tools/cezarion#1810)`, () => {
    let dir = '';
    const recordings = new Map<ToolGrantCaseId, string[]>();
    const errors = new Map<ToolGrantCaseId, AgentEvent[]>();

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), `cez-tool-grant-${backend}-`));
      for (const entry of TOOL_GRANT_CASES) {
        // Relative recording paths: the mock resolves them against its cwd, which is `dir`.
        const obs = await driveSeam(backend, 'baseline', { spec: {
          cwd: dir, sessionId: undefined, toolGrant: entry.grant(backend), cezarTools: DESCRIPTOR,
          env: { CEZ_MOCK_ARGS_FILE: `${entry.id}.args.ndjson`, CEZ_MOCK_STDIN_FILE: `${entry.id}.stdin.ndjson`, CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '', ...entry.env },
        } });
        errors.set(entry.id, obs.v1.filter(event => event.type === 'error'));
        recordings.set(entry.id, readRecording(dir, entry.id));
      }
    }, 120_000);

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    for (const entry of TOOL_GRANT_CASES) {
      it(`${backend} ${entry.name}`, () => {
        expect(errors.get(entry.id)).toEqual([]);
        const recording = recordings.get(entry.id) ?? [];
        expect(recording.length).toBeGreaterThan(0);
        const expected = EXPECTED[backend][entry.id];
        if (expected === SAME_AS_UNSET) {
          expect(recording).toEqual(recordings.get('unset'));
        } else {
          expect(toolFlags(backend, JSON.parse(recording[0]!) as string[])).toEqual(expected);
        }
      });
    }
  });
}
