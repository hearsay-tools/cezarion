/** Worker owns reads/decode/fold only. The index alone may commit a sidecar. */
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import { loadTranscriptFacts, type FactsLoadResult } from './transcript-facts-load.ts';

export interface FactsJobMessage {
  dataDir: string;
  runId: string;
  port: MessagePort;
  signal: SharedArrayBuffer;
}
export type FactsJobReply = { result: FactsLoadResult | undefined; serialized?: string } | { error: string };

// Static dependencies have finished importing before this module body runs.
// Publish readiness before checking cancellation so either side owns shutdown.
const lifecycle = new Int32Array(workerData.lifecycle);
Atomics.store(lifecycle, 0, 1);
if (Atomics.load(lifecycle, 1) === 1) parentPort!.close();
else parentPort!.on('message', ({ dataDir, runId, port, signal }: FactsJobMessage) => {
  let reply: FactsJobReply;
  try {
    const result = loadTranscriptFacts(dataDir, runId);
    reply = { result, ...(result?.needsWrite ? { serialized: JSON.stringify(result.facts) } : {}) };
  } catch (error) {
    reply = { error: String(error) };
  }
  // Publication precedes notification: a blocking parent can consume this exact result.
  port.postMessage(reply);
  Atomics.store(new Int32Array(signal), 0, 1);
  Atomics.notify(new Int32Array(signal), 0);
  port.close();
});
