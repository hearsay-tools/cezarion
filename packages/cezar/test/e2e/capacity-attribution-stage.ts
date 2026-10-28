import { createHash } from 'node:crypto';

export interface AttributionEdit { marker: string; replacement: string }
export interface AttributionInput { sha256: string; edits: readonly AttributionEdit[]; expectedSites: number }

/** Validate all inputs and stage in memory before a caller can write any output. */
export function stageAttribution(sources: Readonly<Record<string, string>>, manifest: Readonly<Record<string, AttributionInput>>): Record<string, string> {
  const staged: Record<string, string> = {};
  const expected = Object.keys(manifest).sort();
  if (JSON.stringify(Object.keys(sources).sort()) !== JSON.stringify(expected)) throw new Error('attribution input inventory changed');
  for (const file of expected) {
    const source = sources[file]!;
    const spec = manifest[file]!;
    if (createHash('sha256').update(source).digest('hex') !== spec.sha256) throw new Error('attribution input hash changed');
    if (source.includes('cezCapacityAttribution')) throw new Error('attribution helper collision');
    if ((source.match(/\?*\.spend\s*\(/g) ?? []).length !== spec.expectedSites) throw new Error('attribution spend inventory changed');
    if (/\?*\.reserve\s*\(/.test(source)) throw new Error('attribution reservation unsupported');
    for (const edit of spec.edits) {
      if (!edit.marker || source.split(edit.marker).length !== 2) throw new Error('attribution marker changed');
    }
  }
  for (const file of expected) {
    let output = sources[file]!;
    for (const edit of manifest[file]!.edits) {
      if (output.split(edit.marker).length !== 2) throw new Error('attribution staged marker changed');
      output = output.replace(edit.marker, edit.replacement);
    }
    staged[file] = output;
  }
  return staged;
}
