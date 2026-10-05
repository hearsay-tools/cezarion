/** Portable multi-message turn fixtures, spelled on each runner's native wire. */
export function turnMessages(prompt) {
  const encoded = prompt.match(/mock:turn-messages:([A-Za-z0-9+/=]+)/)?.[1];
  return encoded ? JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) : undefined;
}
