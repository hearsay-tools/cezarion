import type { CiWaitErrorCode } from '@open-mercato/cezar-contract';

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
