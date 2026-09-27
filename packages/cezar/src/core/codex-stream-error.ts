/** Shared formatting for app-server error notifications (not JSON-RPC errors). */
export function codexStreamError(params: Record<string, unknown>): string | undefined {
  const error = params.error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const { message, additionalDetails } = error as Record<string, unknown>;
  if (typeof message !== 'string' || !message.trim()) return undefined;
  const details = typeof additionalDetails === 'string' ? additionalDetails.trim() : '';
  return details && details !== message.trim() ? `${message.trim()} — ${details}` : message.trim();
}
