import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunnerId } from '../core/agent-runner.ts';

export const CI_INTERRUPTION_CRITERIA = [
  { id: 'R69', scenario: 'hold', name: 'human CI interruption reaches fresh, continued, recovered and retried native input with a withdrawal notice' },
  { id: 'R70', scenario: 'split-text', name: 'ordinary monitoring wakes retain the withdrawn CI status without restoring the wait' },
  { id: 'R71', scenario: 'hold', name: 'queued and recovered custom workflow openings retain withdrawn CI status without a task placeholder' },
] as const;

type NativeInput = {
  userText?: string; method?: string; prompt?: string; url?: string;
  params?: { input?: Array<{ text?: string }>; prompt?: Array<{ text?: string }> };
  body?: { parts?: Array<{ text?: string }> };
};

/** Read the prompts admitted by each runner's native mock, not normalized events. */
export function ciNativeMessages(runner: RunnerId, dir: string): string[] {
  const records = (name: string): Array<NativeInput | string[]> => {
    const path = join(dir, name);
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  };
  const stdin = runner === 'claude' || runner === 'pi' || runner === 'omp';
  const rows = runner === 'cursor' ? [...records('args'), ...records('stdin')] : records(stdin ? 'stdin' : 'args');
  return rows.flatMap(row => {
    if (Array.isArray(row)) return runner === 'cursor' && row.at(-1)?.includes('\n\n---\n\n') ? [row.at(-1)!] : [];
    if (stdin) return row.userText === undefined ? [] : [row.userText];
    if (runner === 'cursor' && row.method === 'cursor-print/stdin' && row.prompt !== undefined) return [row.prompt];
    const parts = runner === 'codex' && row.method === 'turn/start' ? row.params?.input
      : runner === 'cursor' && row.method === 'session/prompt' ? row.params?.prompt
      : runner === 'opencode' && /\/(message|prompt_async)$/.test(row.url ?? '') ? row.body?.parts : undefined;
    return parts ? [parts.map((part: { text?: string }) => part.text ?? '').join('\n')] : [];
  });
}
