const RETRY_HINT = 'Service unavailable: ';
const DEGRADED_XAI_SERVICE = /service temporarily unavailable|availability is currently degraded/i;

export default function registerPiDegradedServiceRetry(pi) {
  pi.on('message_end', (event) => {
    const message = event.message;
    if (message?.role !== 'assistant' || message.provider !== 'xai' || message.stopReason !== 'error') return;
    if (typeof message.errorMessage !== 'string') return;

    const errorMessage = DEGRADED_XAI_SERVICE.test(message.errorMessage)
      ? `${RETRY_HINT}${message.errorMessage}`
      : message.errorMessage;
    if (errorMessage === message.errorMessage) return;
    return { message: { ...message, errorMessage } };
  });
}
