import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { attributionInputs } from './capacity-attribution-sites.ts';

/** Pin the supervisor and its guard inputs for the copied diagnostic. */
const inputs: Record<string, string> = {
  '.github/scripts/linux-mount-alias-probe.py': '24b9a47b30a9729b8349ed46dd0f3f63e0aee291323f10cf7f6e728b41bc292a',
  '.github/scripts/linux_reaper_fixture.py': '07feb95326d19e1b35c5e03cf4e418160a27472ab1605a14592ae648d8d3b530',
  '.github/scripts/linux_detach.py': '7ea1ea29bc2d19aeaf5e2653f1dfb2610a949bdd777882b39cbd90de618594e1',
  '.github/scripts/linux-reaper-regression.mjs': 'bf9baefe766fffe82c7ecdbd7364c34f9ec823f4e33974152f63e5a1c03a133a',
  '.github/scripts/linux-reaper-protocol.mjs': '6c4ff3a86bfa2ec187ce9a587d0103f2ab111359b4f94e60d918893e4e43d78c',
  '.github/scripts/linux-reaper-native-guard.mjs': '096b554ae448302a8cd078bededc6e24846b28a86719cfb6cd15b6c14eeab1f4',
  'packages/cezar/src/delegation/authoritative-capacity-guard.testkit.ts': '24380db6907a2d012bad0618fe7ad147ef9b7a7ae597c15d3f36d1fbddbc53c3',
};
export function validateAttributionSupervisor(root: string): void {
  for (const [file, hash] of Object.entries(inputs)) {
    if (createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex') !== hash) throw new Error(`attribution supervisor changed: ${file}`);
  }
  const sourceRoot = resolve(root, 'packages/cezar/src');
  const scan = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) { scan(path); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.ts') || /\.(?:test|testkit)\.ts$/.test(entry.name)) continue;
      const text = readFileSync(path, 'utf8');
      if (/\?*\.reserve\s*\(/.test(text)) throw new Error('attribution reservation call appeared');
      if (/\?*\.spend\s*\(/.test(text) && !attributionInputs.includes(relative(resolve(sourceRoot, 'delegation'), path))) {
        throw new Error('attribution spend site outside inventory');
      }
    }
  };
  scan(sourceRoot);
}
