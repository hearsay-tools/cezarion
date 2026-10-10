// Synthetic Node uncaught-exception diagnostic matching #499's property/footer layout.
// Native transports call this when a prompt arrives, optionally before its ACK.
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
export function crashWithStderr(prompt, malformedFrame) {
  if (!prompt.includes('mock:crash-stderr')) return false;
  if (prompt.includes('mock:crash-stderr-clean')) {
    writeSync(2, 'harmless shutdown diagnostic\n');
    process.removeAllListeners('SIGTERM');
    process.on('SIGTERM', () => process.exit(143));
    return false;
  }
  if (prompt.includes('mock:crash-stderr-single')) {
    writeSync(2, 'authentication unavailable\n');
    process.exit(7);
  }
  if (prompt.includes('mock:crash-stderr-held-pipe')) {
    // Start the drain deadline only after the descendant is ready. Otherwise
    // cold Node startup competes with the runner's bounded post-exit drain.
    const child = spawn(process.execPath, ['-e', `
      process.on('disconnect', () => {
        setTimeout(() => process.stderr.write('late buffered crash diagnostic\\n'), 40);
        setTimeout(() => {}, 5000);
      });
      process.send('ready');
    `], {
      stdio: ['ignore', process.stdout, process.stderr, 'ipc'],
    });
    child.once('message', () => emitCrash(malformedFrame));
    return true;
  }
  emitCrash(malformedFrame);
}

function emitCrash(malformedFrame) {
  writeSync(2, 'Error: transient connection reset; retrying\nRecovered\n');
  if (malformedFrame) writeSync(1, malformedFrame + '\n');
  writeSync(2, `node:events:496
      throw er; // Unhandled 'error' event
      ^

Error: write EPIPE
    at afterWriteDispatched (node:internal/stream_base_commons:159:15)
    at writeGeneric (node:internal/stream_base_commons:150:3)
Emitted 'error' event on Socket instance at:
    at emitErrorNT (node:internal/streams/destroy:170:8) {
  errno: -32,
  code: 'EPIPE',
  syscall: 'write',
  diagnostic: '${'x'.repeat(700)}'
}

Node.js v24.20.0
`);
  process.exit(1);
}
