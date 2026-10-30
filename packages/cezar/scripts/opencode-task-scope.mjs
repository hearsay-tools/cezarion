// OpenCode plugin that cezar loads into governed sessions (CEZ_DELEGATION=1) through
// OPENCODE_CONFIG_CONTENT (hearsay-tools/cezarion#2279). OpenCode's `task` tool starts the
// session's own subagents, and with `task_id` it resumes any session by ID without a parent
// check, which can reach another cezar task's session. This hook keeps `task` for the
// session's own tree and refuses a `task_id` outside it: cezar tasks talk only through
// `cez message`. The same-user shell stays outside this control (AGENT_PROTOCOL.md D1).

/** Parent links walked before giving up; a real session tree is a few levels deep. */
const MAX_DEPTH = 64;

const REFUSAL = 'This task_id names a session outside this task. Cezar tasks talk to each other only through `cez message`; start a new subagent with task and no task_id instead.';

/**
 * The session's parent ID, null for a root session, or undefined when no such session exists.
 * Any other failure throws, so the caller refuses rather than letting the call through.
 */
async function parentOf(client, id) {
  // SDK v1 reads `path`; the flat v2 form reads `sessionID`. Each ignores the other key.
  const result = await client.session.get({ path: { id }, sessionID: id });
  if (result?.response?.status === 404) return undefined;
  const session = result?.data;
  if (!session || typeof session.id !== 'string') throw new Error(`session ${id} lookup failed`);
  return typeof session.parentID === 'string' && session.parentID !== '' ? session.parentID : null;
}

/** The root of a session's tree, or undefined when the session does not exist. */
async function rootOf(client, id) {
  let current = id;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const parent = await parentOf(client, current);
    if (parent === undefined) return depth === 0 ? undefined : current;
    if (parent === null) return current;
    current = parent;
  }
  throw new Error(`session ${id} has more than ${MAX_DEPTH} ancestors`);
}

/** Refuses a `task` call whose `task_id` names a session outside the caller's session tree. */
async function checkTaskScope(client, sessionID, args) {
  const target = args?.task_id;
  if (typeof target !== 'string' || target === '') return;
  let allowed;
  try {
    const targetRoot = await rootOf(client, target);
    // OpenCode starts a fresh subagent session for an unknown task_id.
    if (targetRoot === undefined) return;
    allowed = targetRoot === await rootOf(client, sessionID);
  } catch {
    allowed = false;
  }
  if (!allowed) throw new Error(REFUSAL);
}

// The only export: OpenCode may call every exported function as a plugin.
export const CezarTaskScope = async ({ client }) => ({
  'tool.execute.before': async (input, output) => {
    if (input.tool === 'task') await checkTaskScope(client, input.sessionID, output.args);
  },
});
