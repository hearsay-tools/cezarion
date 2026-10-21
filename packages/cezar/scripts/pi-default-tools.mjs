// hearsay-tools/cezarion#1305: pi reads --tools as an allowlist, so a session given cezar's default
// tool list could not call an MCP server's tools (direct, codemode or deferred) or any tool another
// pi extension registers. For the default list cezar sends --no-builtin-tools instead, which keeps
// every tool registered, activates extension tools on registration and leaves the built-ins
// inactive, and names the built-ins in --cezar-builtin-tools for this extension to activate.
//
// Written against pi 1.0.4. The names are added to the active tools on every session_start
// (startup, resume, new, reload), never removed: pi's MCP extension activates codemode and
// tool_search itself, before or after this handler runs. pi ignores unknown and hidden names, and an
// --exclude-tools name is never registered, so naming one here cannot bring it back.
const FLAG = 'cezar-builtin-tools';

export default function registerPiDefaultTools(pi) {
  pi.registerFlag(FLAG, { type: 'string', description: 'Built-in tools cezar activates (default tool list)' });
  pi.on('session_start', () => {
    const value = pi.getFlag(FLAG);
    if (typeof value !== 'string') return;
    const names = value.split(',').map((name) => name.trim()).filter(Boolean);
    if (names.length === 0) return;
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]);
  });
}
