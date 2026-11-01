import type { RawUsage } from './usage.ts';

// Claude stream-json frames and the pure predicates the Claude runner reads them with.
// Only `claude-cli-runner.ts` imports this module (hearsay-tools/cezarion#1954).

export interface ClaudeStreamMessage {
  type?: string;
  subtype?: string;
  model?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  message?: {
    role?: string;
    content?: unknown[];
    usage?: RawUsage;
  };
  // `result` messages carry these at the top level.
  result?: string;
  usage?: RawUsage;
  is_error?: boolean;
  total_cost_usd?: number;
  modelUsage?: unknown;
  /** #505: stdin echo at consumption (`--replay-user-messages`) and result coverage. */
  uuid?: string;
  isReplay?: boolean;
  user_message_uuids?: unknown[];
  queued_turn_count?: number;
}

/** Fail closed on absent/partial/invalid usage; include cache and nested counters. */
export function zeroClaudeUsage(usage: unknown): boolean {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false;
  const record = usage as Record<string, unknown>;
  if (record.input_tokens !== 0 || record.output_tokens !== 0) return false;
  const zero = (value: unknown): boolean => typeof value === 'number' ? value === 0
    : value !== null && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(zero);
  return Object.entries(record).every(([key, value]) => {
    // Claude includes this non-accounting metadata in some usage envelopes.
    return (key === 'service_tier' && typeof value === 'string') || zero(value);
  });
}

/** Per-model accounting must agree with the aggregate before replay is safe. */
export function zeroClaudeModelUsage(usage: unknown): boolean {
  if (usage === undefined) return true;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false;
  return Object.values(usage).every(model => {
    if (!model || typeof model !== 'object' || Array.isArray(model)) return false;
    const record = model as Record<string, unknown>;
    if (record.inputTokens !== 0 || record.outputTokens !== 0) return false;
    return Object.entries(record).every(([key, value]) =>
      key === 'contextWindow' || key === 'maxOutputTokens'
        ? typeof value === 'number' && Number.isFinite(value) && value >= 0
        : value === 0);
  });
}

/** Whether a frame shows model work, which forbids a refusal replay (hearsay-tools/cezarion#1351). */
export function claudeFrameDidWork(msg: ClaudeStreamMessage, reportedModel: string | undefined): boolean {
  // Background tasks and hooks can start work without assistant content
  // or token usage. Only init is known to be identity-only metadata.
  if ((msg.type === 'system' && msg.subtype !== 'init') || msg.type === 'tool_progress') return true;
  if (msg.type !== 'assistant' && msg.type !== 'user') return false;
  // A refusal's own visible text is diagnostic, not model work. Any
  // other output, tool call/result, reasoning or nonzero usage forbids replay.
  if (msg.message?.usage && !zeroClaudeUsage(msg.message.usage)) return true;
  const content = msg.message?.content;
  if (content !== undefined && !Array.isArray(content)) return true;
  return (Array.isArray(content) ? content : []).some(block => {
    if (!block || typeof block !== 'object') return true;
    const b = block as { type?: string; text?: string };
    return b.type !== 'text' || selectedModelRefusal(b.text) !== reportedModel || !reportedModel;
  });
}

export function selectedModelRefusal(text: unknown): string | undefined {
  return typeof text === 'string'
    ? /^There's an issue with the selected model \(([^()]+)\)\. It may not exist or you may not have access to it\. Run --model to pick a different model\.$/.exec(text.trim())?.[1]
    : undefined;
}

export function normalizeIntentionalTeardownResult(
  msg: ClaudeStreamMessage,
  terminatedByCezar: boolean,
): ClaudeStreamMessage {
  if (
    terminatedByCezar
    && msg.type === 'result'
    && msg.is_error === true
    && msg.subtype === 'error_during_execution'
  ) {
    return { ...msg, subtype: 'success', is_error: false };
  }
  return msg;
}

/**
 * Whether a frame is the parent agent's own model output (hearsay-tools/cezarion#1512). Claude can
 * resume the parent without a stdin line — a background task's notification, a native peer message —
 * and its first parent `assistant` frame is the only sign. Init, hooks, `task_*` frames, replays and
 * a child's nested output (a non-null `parent_tool_use_id`) are not parent work.
 */
export function isParentAssistantFrame(msg: ClaudeStreamMessage): boolean {
  return msg.type === 'assistant' && (msg.parent_tool_use_id === undefined || msg.parent_tool_use_id === null || msg.parent_tool_use_id === '');
}
