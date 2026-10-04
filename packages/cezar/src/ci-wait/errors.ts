import type { CiWaitErrorCode, PreviewResultCode, PreviewServeResult } from '@open-mercato/cezar-contract';
import type { z } from 'zod';

/** Safe diagnostics shared by the manager and private transport. Never forward raw errors. */
const messages: Record<CiWaitErrorCode, string> = {
  wait_conflict: 'A different CI wait is already active for this run.',
  unsupported_host: 'GitHub Enterprise host is not recognized; use a host configured with the existing GitHub authentication.',
  gh_missing: 'Install GitHub CLI (gh) to wait for CI.',
  authentication: 'Authenticate GitHub CLI with gh auth login and retry.',
  inaccessible_pr: 'The pull request is inaccessible; check its URL and GitHub permissions.',
  capacity: 'CI wait registration capacity is exhausted; retry later.',
  persistence: 'CI wait could not be saved; check local storage and retry.',
  query_timeout: 'GitHub metadata lookup timed out; check connectivity and retry.',
  invalid_request: 'Invalid CI wait arguments.',
  malformed_data: 'GitHub returned invalid CI metadata; check the pull request and retry.',
  output_limit: 'GitHub CI metadata exceeded the output limit; inspect the pull request before retrying.',
  command_failed: 'The GitHub CI query failed; check GitHub CLI connectivity and retry.',
  unavailable: 'CI tool unavailable: registration failed. Retry from the current session.',
  unauthorized: 'CI tool unavailable: session capability is missing or revoked. Use the current session tool.',
  manager_disposed: 'The run manager was disposed. Resume the task in a running cockpit before waiting for CI.',
  capability_revoked: 'The CI session capability was revoked. Use the current session tool.',
  run_missing: 'The run no longer exists. Start or resume an existing task before waiting for CI.',
  run_not_running: 'The run is not running or waiting. Resume it before registering a CI wait.',
  run_stopping: 'The run is stopping. Wait for it to stop, then resume before registering a CI wait.',
  session_replaced: 'The session was replaced or there is no active session. Use the current session tool after resuming.',
  session_closed: 'The agent session is closed. Resume the task before registering a CI wait.',
  run_cancelled: 'The run was cancelled. Resume it before registering a CI wait.',
  finish_requested: 'Run finish was requested. Complete that transition before resuming and registering a CI wait.',
  generation_mismatch: 'This CI tool belongs to an earlier session. Use the current session tool.',
  human_ask_pending: 'A human question is pending in this session. Wait for its answer before registering a CI wait.',
  human_ask_unanswered: 'A recorded human question is unanswered. Wait for its answer before registering a CI wait.',
  worker_wait_pending: 'A worker wait is still pending, including any result awaiting delivery. End your turn to receive its result, then retry the CI wait.',
  worker_execution_stopped: 'Worker execution has stopped. Ask the parent to resume the worker before waiting for CI.',
  root_finish_pending: 'The parent is finishing. Complete that transition before resuming and registering a CI wait.',
  registration_aborted: 'CI registration was interrupted during lookup. Retry from the current turn if a wait is still needed.',
  turn_changed: 'The agent turn changed during CI lookup. Register the wait again from the current turn.',
};

export function ciErrorMessage(code: CiWaitErrorCode): string {
  return messages[code];
}

// #781: `cezar_preview_serve` results. Every one carries the agent's next step; none quotes a
// secret, an environment value or another task's path.
const EXAMPLE_CALL = '{ "command": "npm run dev -- --port 5173 --strictPort", "port": 5173 }';

/** The refusals cezar's tool server answers itself; registration codes come from its owner. */
export function previewRefusal(code: Extract<PreviewResultCode, 'preview_disabled' | 'headless' | 'unavailable'>): PreviewServeResult {
  switch (code) {
    case 'preview_disabled': return { ok: false, code, message: 'Live preview is not enabled in this cockpit.', hint: 'Do not retry. Tell the user the server command and port so they can open it themselves.' };
    case 'headless': return { ok: false, code, message: 'No cockpit is attached to this run (`cez run`).', hint: 'Do not retry. Report the command and port in your final message.' };
    case 'unavailable': return { ok: false, code, message: 'Cezar\'s tool server did not answer.', hint: 'Retry once. If it fails again, continue without preview and report the command and port in your message.' };
  }
}

const FIELD_RULES: Record<string, string> = {
  command: 'must be a string of 1 to 1024 characters',
  port: 'must be an integer between 1 and 65535',
  cwd: 'must be a path relative to the worktree root',
  label: 'must be a string of 1 to 48 characters',
  path: 'must be a path starting with "/"',
};

export function previewOversized(): PreviewServeResult {
  return { ok: false, code: 'invalid_input', message: 'The arguments exceed 16 KiB.', hint: `Send only the documented fields, e.g. ${EXAMPLE_CALL}, and call again.` };
}

/** Names the first failing field and its rule, then a valid example call. */
export function previewInvalidInput(error: z.ZodError, input: unknown): PreviewServeResult {
  const field = error.issues.map(issue => issue.path[0]).find((key): key is string => typeof key === 'string' && key in FIELD_RULES);
  if (!field) {
    return { ok: false, code: 'invalid_input', message: 'The arguments must be a JSON object with `command` and `port`.', hint: `Call again with a JSON object, e.g. ${EXAMPLE_CALL}.` };
  }
  const value = input !== null && typeof input === 'object' ? (input as Record<string, unknown>)[field] : undefined;
  const got = value === undefined ? 'nothing' : JSON.stringify(value).slice(0, 64);
  return {
    ok: false,
    code: 'invalid_input',
    message: `\`${field}\` ${FIELD_RULES[field]} (got ${got}).`,
    hint: `"${field}" ${FIELD_RULES[field]}. A valid call: ${EXAMPLE_CALL}. Fix the field and call again.`,
  };
}
