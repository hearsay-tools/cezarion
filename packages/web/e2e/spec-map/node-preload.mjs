// Loaded only by the spec-map workflow through NODE_OPTIONS. No application imports this hook.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Session } from 'node:inspector';
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import crypto, { createHash } from 'node:crypto';
import { takeCoverage } from 'node:v8';

const root = process.env.E2E_SPEC_MAP_NODE_DIR;
const owner = process.env.E2E_SPEC_MAP_OWNER;
const isServer = /[/\\]dist[/\\]index\.js$/.test(process.argv[1] ?? '');
if (root && (isServer || owner)) await install(root, owner);

async function install(root, owner) {
  mkdirSync(join(root, 'processes'), { recursive: true });
  mkdirSync(join(root, 'servers'), { recursive: true });
  const socket = join(process.platform === 'win32' ? tmpdir() : '/tmp', `cez-map-${createHash('sha256').update(root).digest('hex').slice(0, 12)}-${process.pid}.sock`);
  const session = new Session();
  let active = owner ? undefined : process.env.E2E_SPEC_MAP_SPEC;
  const shared = !owner && !process.env.E2E_SPEC_MAP_SPEC;
  let startupSaved = false;
  let sequence = 0;
  let spawnSequence = 0;
  const owners = new Map();
  if (!owner) {
    session.connect();
    session.post('Profiler.enable');
    session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
    if (active) expectServer(active);
    patchCreation();
    patchSpawn();
  }
  const server = createServer(connection => {
    let input = '';
    connection.on('data', chunk => { input += chunk; if (input.includes('\n')) receive(); });
    function receive() {
      try {
        const command = JSON.parse(input);
        if (command.action === 'begin') {
          snapshot(undefined, shared && !startupSaved);
          startupSaved = true;
          active = command.spec;
          expectServer(active);
        }
        else if (command.action === 'end') { snapshot(active); active = undefined; }
        else if (command.action === 'flush' && owner) takeCoverage();
        else throw new Error('unknown capture command');
        connection.end('{"ok":true}\n');
      } catch (error) { connection.end(`${JSON.stringify({ error: error.message })}\n`); }
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => {
      server.unref();
      const manifest = { socket, pid: process.pid, spec: owner, taskId: process.env.CEZ_TASK_ID };
      writeRecord(join(root, owner ? 'processes' : 'servers', `${process.pid}.json`), manifest);
      if (!owner && !process.env.E2E_SPEC_MAP_SPEC) writeRecord(join(root, 'control.json'), manifest);
      resolve();
    });
  });
  process.on('exit', () => {
    if (!owner) snapshot(active);
    try { unlinkSync(socket); } catch {}
  });
  {
    function flushSignal() {
      if (owner) takeCoverage();
      else snapshot(active);
      if (process.listenerCount('SIGTERM') === 1) {
        process.removeListener('SIGTERM', flushSignal);
        try { unlinkSync(socket); } catch {}
        process.kill(process.pid, 'SIGTERM');
      }
    }
    process.prependListener('SIGTERM', flushSignal);
  }
  function expectServer(spec) {
    const dir = join(root, basename(spec, '.e2e.ts'), 'node');
    mkdirSync(dir, { recursive: true });
    writeRecord(join(dir, `expected-server-${process.pid}.json`), { spec, pid: process.pid });
  }
  function snapshot(spec, startup = false) {
    session.post('Profiler.takePreciseCoverage', (error, result) => {
      if (error) throw error;
      if (startup) {
        writeRecord(join(root, `shared-startup-${process.pid}.json`), result);
        return;
      }
      if (!spec) return;
      const dir = join(root, basename(spec, '.e2e.ts'), 'node');
      mkdirSync(dir, { recursive: true });
      writeRecord(join(dir, `server-${process.pid}-${sequence++}.json`), result);
    });
  }
  function patchCreation() {
    const original = crypto.randomUUID;
    crypto.randomUUID = function() {
      const id = original.apply(this, arguments);
      if (active) owners.set(id, active);
      return id;
    };
  }
  function patchSpawn() {
    const original = childProcess.spawn;
    childProcess.spawn = function(command, args, options) {
      const opts = Array.isArray(args) ? options : args;
      const task = opts?.env?.CEZ_TASK_ID;
      const childArgs = Array.isArray(args) ? args : [];
      const isMock = [command, ...childArgs].some(arg => /[/\\]mock-[^/\\]+\.mjs$/.test(arg));
      if (task && isMock && !owners.has(task)) {
        writeRecord(join(root, `ambiguous-task-${task}.json`), { taskId: task });
        if (active) owners.set(task, active);
      }
      const spec = owners.get(task);
      if (spec && isMock) {
        const directory = join(root, basename(spec, '.e2e.ts'), 'node', 'tasks', task, `${process.pid}-${spawnSequence++}`);
        mkdirSync(directory, { recursive: true });
        writeRecord(join(directory, 'expected.json'), { spec, taskId: task });
        const env = { ...(opts?.env ?? process.env), E2E_SPEC_MAP_NODE_DIR: root,
          E2E_SPEC_MAP_OWNER: spec, NODE_V8_COVERAGE: directory };
        return original.call(this, command, childArgs, { ...opts, env });
      }
      return original.apply(this, arguments);
    };
    syncBuiltinESMExports();
  }
}

function writeRecord(file, value) {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, file);
}
