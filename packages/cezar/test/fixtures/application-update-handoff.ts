// Source-only child fixture. Run with tsx in a separate process from jsdom.
import { RunManager } from '../../src/workflows/run.ts';
import { createRunner } from '../../src/core/runner-factory.ts';
import { mkdir, writeFile, cp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { ApplicationUpdateService } from '../../src/application-update/service.ts';
import { RunStore } from '../../src/runs/store.ts';
import { startServer } from '../../src/server/server.ts';
import { Home } from '../../src/home/home.ts';
const root = process.argv[2];
if (!root) throw new Error('Expected fixture root');
const failedArm = process.argv[3] === 'failed-arm';
const home = Home.sandbox(join(root, 'home'));
const original = join(root, 'prefix/lib/node_modules/@wjarka/cezarion');
await mkdir(join(original, 'dist'), { recursive: true });
await mkdir(join(original, 'web/dist'), { recursive: true });
await writeFile(join(original, 'package.json'), JSON.stringify({name:'@wjarka/cezarion',version:'1.0.0',bin:{cez:'dist/index.js'},dependencies:{}}));
await writeFile(join(original, 'dist/index.js'), '');
await writeFile(join(original, 'web/dist/index.html'), '');
let arm!: () => void;
const gate = new Promise<void>(resolve => { arm = resolve; });
let handoffs = 0;
const service = new ApplicationUpdateService({ packageRoot: original, launchEntry: join(original,'dist/index.js'),
  npmPrefix: join(root,'prefix'), npmCache: join(root,'cache'), home: home.root, targetVersion: () => '2.0.0',
  runNpm: async args => {
    const prefix = args[args.indexOf('--prefix') + 1];
    if (!prefix) throw new Error('Expected npm prefix');
    const target = join(prefix, 'node_modules/@wjarka/cezarion');
    await cp(original, target, {recursive:true});
    const pkg = JSON.parse(await readFile(join(target,'package.json'),'utf8')); pkg.version = '2.0.0';
    await writeFile(join(target,'package.json'),JSON.stringify(pkg));
  },
  armRestart: async () => { await gate; if (failedArm) { process.send?.({event:'arm-failed'}); throw new Error('fixture arm failure'); } process.send?.({event:'armed'}); },
  handoff: () => { process.send?.({event:'handoff', count: ++handoffs}); void server.shutdownForRestart(); },
});
await service.apply();
const store = RunStore.open(join(root, '.ai/cezar'));
const manager = new RunManager(store, root, { home, createRunner });
const server = startServer({home, repoRoot:root, store, manager, version:'1.0.0', applicationUpdate:service},0);
server.prependListener('request', (req,res) => { if (req.url?.endsWith('/restart')) {
  res.on('finish', () => process.send?.({event:'finish'}));
  res.on('close', () => process.send?.({event:'close'}));
}});
process.on('message', message => { if(message === 'arm') arm(); });
await once(server,'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
process.send?.({event:'listening',port:address.port});
