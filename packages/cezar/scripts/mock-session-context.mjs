// hearsay-tools/cezarion#1584: an opening message starts with <cezar-context> blocks, and the
// handoff block repeats the task's Goal. A mock picks its scenario from `mock:` tokens anywhere
// in the text, so without this a Continue would replay the first task's scenario. Mocks record
// the raw native text, then match scenarios on the text without the blocks.
const BLOCK = /^<cezar-context id="[^"]*"(?: source="[^"]*")?>\n[\s\S]*?\n<\/cezar-context>(?:\n\n)?/;
const SEPARATOR = '---\n\n';

/** `text` without its leading session-context blocks and their separator; unchanged otherwise. */
export function withoutSessionContext(text) {
  if (typeof text !== 'string') return text;
  // In-thread runners put their system instructions first, divided by the same separator.
  const start = text.indexOf('<cezar-context id="');
  if (start < 0 || (start > 0 && !text.slice(0, start).endsWith('\n\n---\n\n'))) return text;
  let rest = text.slice(start);
  let stripped = false;
  for (let match = BLOCK.exec(rest); match; match = BLOCK.exec(rest)) {
    rest = rest.slice(match[0].length);
    stripped = true;
  }
  if (!stripped || !rest.startsWith(SEPARATOR)) return text;
  return text.slice(0, start) + rest.slice(SEPARATOR.length);
}

/** The same for an OpenCode request body: each part's text, the JSON otherwise unchanged. */
export function withoutSessionContextBody(body) {
  // A JSON body escapes the attribute's quote, so look for the tag name alone.
  if (!body || !body.includes('<cezar-context id=')) return body;
  try {
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed.parts)) return body;
    return JSON.stringify({ ...parsed, parts: parsed.parts.map((part) => typeof part?.text === 'string' ? { ...part, text: withoutSessionContext(part.text) } : part) });
  } catch {
    return body;
  }
}

/** The same for a list of native input parts (Codex `input`, ACP `prompt`). */
export function withoutSessionContextParts(parts) {
  return Array.isArray(parts)
    ? parts.map((part) => typeof part?.text === 'string' ? { ...part, text: withoutSessionContext(part.text) } : part)
    : parts;
}

const RAW = new WeakMap();
/** Pi/OMP RPC: strip `command.message` for matching and keep the raw text for the recording. */
export function stripCommandMessage(command) {
  if (command && typeof command.message === 'string') {
    RAW.set(command, command.message);
    command.message = withoutSessionContext(command.message);
  }
  return command;
}
/** The native text a Pi/OMP command arrived with, for the recording. */
export function rawMessage(command) {
  return RAW.has(command) ? RAW.get(command) : command.message;
}
