import { commandText } from '../home/command.ts';
import { productEnv } from '../core/product-env.ts';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { delegationErrorResponseSchema } from '@open-mercato/cezar-contract/delegation';
import {
  discoveredRunnersSchema,
  hostDiscoveryRequestSchema as discoveryRequestSchema,
} from '@open-mercato/cezar-contract/discovery';
import {
  providerStatusResponseSchema,
  runnerModelCatalogResponseSchema,
} from '@open-mercato/cezar-contract/workspace';
import { boundedJson, delegationEndpoint } from '../delegation/cli.ts';
import { discoverCockpit, type DiscoverOptions } from '../task-cli/discovery.ts';
import { fetchJson, invalidResponse, refuse, TaskCliError, type Cockpit } from '../task-cli/http.ts';
import { discoveredRunners } from './catalog.ts';

interface DiscoveryIo {
  stdout(line: string): void;
  discover?: (options: DiscoverOptions) => Promise<Cockpit>;
}
const HELP = commandText(`cez discover — inspect the host's default-account catalog

Usage:
  cez discover runners
  cez discover models --runner <claude|codex|opencode|pi|cursor>

Options:
  --url <origin>  Cockpit to use (also CEZ_URL); operators only.
  --repo <dir>    Checkout whose cockpit to find (default cwd); operators only.
  -h, --help     Show help without contacting a controller.

Commands return JSON. Runners include connection status and enablement.
Model rows include effortLevels when advertised; absent means unknown, [] means
no advertised levels. Omit an effort pin to use the runner's default.
Catalog source/stale/reason describe discovery availability and freshness.
Inside a parent session, discovery uses its authenticated controller, including
headless runs. It never falls back to another cockpit on authentication failure.
Outside a session, it finds an existing cockpit; it never starts one.
Catalogs describe host default accounts, not every named account or spawn policy.`);

/** Discovery through the session's own controller. A failure never escapes to another cockpit. */
async function sessionDiscovery(env: NodeJS.ProcessEnv, request: z.infer<typeof discoveryRequestSchema>, schema: z.ZodType, print: (value: unknown) => void): Promise<number> {
  try {
    const endpoint = delegationEndpoint(productEnv('DELEGATION_URL', env));
    const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(productEnv('DELEGATION_TOKEN', env));
    const response = await fetch(`${endpoint.href}/discover`, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(45_000) });
    const data = await boundedJson(response);
    if (!response.ok) { print(delegationErrorResponseSchema.parse(data)); return 2; }
    print(schema.parse(data)); return 0;
  } catch {
    throw new TaskCliError(2, { code: 'unavailable_transport', error: 'Discovery session is unavailable or returned an invalid response.' });
  }
}

/** Discover through an existing cockpit; never starts one. Fetches and decodes the catalog for one request kind. */
async function cockpitDiscovery(io: DiscoveryIo, env: NodeJS.ProcessEnv, values: { url?: string; repo?: string }, request: z.infer<typeof discoveryRequestSchema>, print: (value: unknown) => void): Promise<number> {
  const cockpit = await (io.discover ?? discoverCockpit)({ repoDir: values.repo ?? process.cwd(), ...(values.url ?? productEnv('URL', env) ? { url: values.url ?? productEnv('URL', env) } : {}) });
  const response = await fetchJson(`${cockpit.origin}/api/v1/${request.kind === 'runners' ? 'providers/status' : `models?runner=${encodeURIComponent(request.runner)}`}`);
  if (response.status !== 200) refuse(response);
  if (request.kind === 'runners') {
    const parsed = providerStatusResponseSchema.safeParse(response.data);
    if (!parsed.success) invalidResponse('runners');
    print(discoveredRunners(parsed.data));
    return 0;
  }
  const parsed = runnerModelCatalogResponseSchema.safeParse(response.data);
  if (!parsed.success) invalidResponse('models');
  print(parsed.data);
  return 0;
}

type ParsedDiscovery =
  | { help: true }
  | { help: false; values: ReturnType<typeof parseDiscoveryArgs>['values']; request: z.infer<typeof discoveryRequestSchema>; schema: z.ZodType };

/** Argument parsing and request validation for `cez discover`. `--help` wins over validation. */
function parseDiscoveryRequest(argv: string[]): ParsedDiscovery {
  let parsed: ReturnType<typeof parseDiscoveryArgs>;
  try { parsed = parseDiscoveryArgs(argv); }
  catch { throw new TaskCliError(64, { code: 'invalid_input', error: commandText('Use cez discover runners or cez discover models --runner=<runner>. See cez discover --help.') }); }
  if (parsed.values.help) return { help: true };
  const selected = discoveryRequestSchema.safeParse({ kind: parsed.positionals[0], ...(parsed.values.runner === undefined ? {} : { runner: parsed.values.runner }) });
  if (parsed.positionals.length !== 1 || !selected.success) throw new TaskCliError(64, { code: 'invalid_input', error: commandText('Use cez discover runners or cez discover models --runner=<runner>.') });
  const request = selected.data;
  return { help: false, values: parsed.values, request, schema: request.kind === 'runners' ? discoveredRunnersSchema : runnerModelCatalogResponseSchema };
}

export async function runDiscoverCommand(argv: string[], env: NodeJS.ProcessEnv = process.env, io: DiscoveryIo = { stdout: line => console.log(line) }): Promise<number> {
  const print = (value: unknown) => {
    let line = JSON.stringify(value);
    const token = productEnv('DELEGATION_TOKEN', env);
    if (token) line = line.replaceAll(token, '[REDACTED]');
    io.stdout(line);
  };
  try {
    const parsed = parseDiscoveryRequest(argv);
    if (parsed.help) { io.stdout(HELP); return 0; }
    const { values, request, schema } = parsed;
    // Even a partial/expired session must not silently escape its controller or scope.
    if (productEnv('DELEGATION_URL', env) !== undefined || productEnv('DELEGATION_TOKEN', env) !== undefined) {
      if (values.url !== undefined || values.repo !== undefined) throw new TaskCliError(64, { code: 'invalid_input', error: 'A delegation session uses its own controller; --url and --repo are unavailable.' });
      return await sessionDiscovery(env, request, schema, print);
    }
    return await cockpitDiscovery(io, env, values, request, print);
  } catch (error) {
    if (error instanceof TaskCliError) { print(error.body); return error.exitCode; }
    print({ code: 'unavailable', error: 'Discovery is unavailable.' }); return 2;
  }
}

function parseDiscoveryArgs(args: string[]) {
  return parseArgs({ args, allowPositionals: true, strict: true, options: {
    runner: { type: 'string' }, url: { type: 'string' }, repo: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
}
