// A stand-in dev server for the supervisor tests (#781): listens on a port after an optional delay,
// optionally forks a child that holds the port (npm -> node -> vite), optionally prints N lines.
//   --port N [--delay MS] [--host H] [--fork] [--lines N] [--exit-code C] [--stdin-eof]
//   [--leader-exits] (with --fork: the leader exits once the holder listens) [--ignore-term] (the holder ignores SIGTERM)
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const value = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);

const port = Number(value('port', 0));
const delay = Number(value('delay', 0));
const host = value('host', '127.0.0.1');

for (let line = 1; line <= Number(value('lines', 0)); line += 1) console.log(`fake-dev-server line ${line}`);

if (flag('exit-code')) process.exit(Number(value('exit-code', 0)));

if (flag('stdin-eof')) {
  process.stdin.resume();
  process.stdin.on('end', () => { console.log('stdin-eof'); process.exit(0); });
} else if (flag('fork') && !flag('holder')) {
  // Same process group as this process: a supervisor that kills only our pid leaves the holder up.
  const holder = spawn(process.execPath, [fileURLToPath(import.meta.url), '--holder', '--port', String(port), '--delay', String(delay), '--host', host, ...(flag('ignore-term') ? ['--ignore-term'] : [])], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (flag('leader-exits')) holder.stdout.once('data', () => process.exit(3));
  setInterval(() => {}, 1 << 30);
} else {
  if (flag('ignore-term')) process.on('SIGTERM', () => {});
  setTimeout(() => createServer(socket => socket.end()).listen(port, host, () => console.log(`listening on ${host}:${port}`)), delay);
  setInterval(() => {}, 1 << 30);
}
