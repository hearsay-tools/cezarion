import { unknownToolGrant, type ToolGrant } from './agent-runner.ts';

/**
 * How each runner without a tool-list builder of its own maps a `ToolGrant` onto its wire
 * (hearsay-tools/cezarion#1810). One exhaustive switch per runner, so a new grant kind fails to
 * compile until every runner decides what it sends. Claude and pi keep their switches beside
 * the builders they call.
 */

/** The thread fields each grant kind adds: none, since the app-server has no per-tool allowlist. */
export function codexToolGrantFields(grant: ToolGrant): Record<never, never> {
  switch (grant.kind) {
    case 'unset':
    case 'step-default':
    case 'inherited':
    case 'explicit': return {};
    default: return unknownToolGrant(grant);
  }
}

/** The session fields each grant kind adds: none, since OpenCode's own permission config governs tools. */
export function opencodeToolGrantFields(grant: ToolGrant): Record<never, never> {
  switch (grant.kind) {
    case 'unset':
    case 'step-default':
    case 'inherited':
    case 'explicit': return {};
    default: return unknownToolGrant(grant);
  }
}

/** The print flags each grant kind adds: none. Only D1 sends `--allowed-tools`, from the capability list. */
export function cursorPrintToolGrantArgs(grant: ToolGrant): string[] {
  switch (grant.kind) {
    case 'unset':
    case 'step-default':
    case 'inherited':
    case 'explicit': return [];
    default: return unknownToolGrant(grant);
  }
}

/**
 * The names a grant asks OMP for, or undefined for OMP's own default set. That set includes
 * unrestricted bash, so a bash allowlist has to name a list (`defaults`, OMP's default set) to
 * leave it out.
 */
export function ompRequestedTools(
  grant: ToolGrant,
  defaults: readonly string[],
): readonly string[] | undefined {
  switch (grant.kind) {
    case 'unset': return (grant.bashAllowlist?.length ?? 0) > 0 ? defaults : undefined;
    case 'step-default':
    case 'inherited': return grant.tools;
    // `--tools` filters OMP's built-ins only, so a narrowed list leaves every MCP and extension
    // tool callable (hearsay-tools/cezarion#1357).
    case 'explicit': return grant.tools;
    default: return unknownToolGrant(grant);
  }
}
