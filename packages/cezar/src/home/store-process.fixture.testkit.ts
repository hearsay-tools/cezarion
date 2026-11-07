import { homePaths } from './home.ts';
import { prepareHome, type HomeEntry } from './entry.ts';
import { HomeStore } from './store.ts';
import { holdCockpitLease, readCockpitLeases } from './leases.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';

const [root, command, argument] = process.argv.slice(2) as [string, string, string];
const home = homePaths(root, `${root}/cache`, root);
const store = new HomeStore(home);
switch (command) {
  case 'prepare': prepareHome(home, argument as HomeEntry); break;
  case 'write': store.writeJson(home.workspaceConfig, JSON.parse(argument)); break;
  case 'read': console.log(store.read(home.workspaceConfig)); break;
  case 'outside': console.log(JSON.stringify(store.outsideWrite(home.workspaceConfig) ?? null)); break;
  case 'restore': store.restoreOutsideWrite(home.workspaceConfig); break;
  case 'increment':
    for (let i = 0; i < Number(argument); i++) await mergeWriteWorkspaceConfig(value => { value.count = Number(value.count ?? 0) + 1; }, home);
    break;
  case 'lease': {
    const release = holdCockpitLease(home, Number(argument));
    process.send?.({ ready: true });
    process.once('message', () => { release(); process.disconnect?.(); });
    break;
  }
  case 'leases': console.log(JSON.stringify(readCockpitLeases(home))); break;
  default: throw new Error(`Unknown fixture command ${command}`);
}
