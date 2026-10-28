import { posix } from 'node:path';

/** Pure, bounded mount translation. Identity checks and signalling are separate. */
export interface AliasMount {
  dev: string;
  root: string;
  point: string;
}
export interface OwnedMountRoot {
  path: string;
  dev: string;
  fsPath: string;
}

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_MOUNTS = 16_384;
const MAX_CANDIDATES = 1024;
const MAX_COMPONENTS = 256;

/** One budget must be shared by all evidence examined during a scan attempt. */
export class AliasBudgetExceeded extends Error {
  constructor() { super('alias scan work exceeds bounds'); }
}

export class AliasWorkBudget {
  constructor(private remaining = 200_000) {}
  spend(amount = 1): void {
    this.remaining -= amount;
    if (this.remaining < 0) throw new AliasBudgetExceeded();
  }
}

function pathValid(value: string): boolean {
  return Buffer.byteLength(value) <= 4096 && value.startsWith('/') && !value.includes('\0') && !value.includes('\ufffd') &&
    !value.split('/').some(part => part === '.' || part === '..') &&
    value.split('/').length <= MAX_COMPONENTS && posix.normalize(value) === value;
}

function decodeMountPath(value: string): string {
  if (/\\(?!040|011|012|134)/.test(value)) throw new Error('invalid mount escape');
  const path = value.replace(/\\(040|011|012|134)/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  if (!pathValid(path)) throw new Error('invalid mount path');
  return path;
}

function devKey(value: string, radix: 10 | 16): string {
  const match = /^([0-9a-f]+):([0-9a-f]+)$/i.exec(value);
  if (!match || match[1]!.length > (radix === 16 ? 16 : 20) || match[2]!.length > (radix === 16 ? 16 : 20) ||
      (radix === 10 && /[a-f]/i.test(value))) throw new Error('invalid device');
  const parse = (part: string) => BigInt(radix === 16 ? '0x' + part : part).toString();
  return parse(match[1]!) + ':' + parse(match[2]!);
}

function suffix(path: string, root: string): string | undefined {
  if (path === root) return '';
  if (root === '/') return path.startsWith('/') ? path : undefined;
  return path.startsWith(root + '/') ? path.slice(root.length) : undefined;
}

export function parseAliasMounts(content: string, budget = new AliasWorkBudget()): AliasMount[] {
  if (Buffer.byteLength(content) > MAX_BYTES || !content) throw new Error('mount evidence exceeds bounds');
  const lines = content.split('\n').filter(Boolean);
  if (!lines.length || lines.length > MAX_MOUNTS) throw new Error('mount evidence exceeds bounds');
  return lines.map(line => {
    budget.spend();
    const fields = line.split(' '), separator = fields.indexOf('-');
    if (separator < 6 || fields.length < separator + 4 || !/^\d+$/.test(fields[0] ?? '') ||
        !/^\d+$/.test(fields[1] ?? '') || !fields[5]) throw new Error('malformed mount evidence');
    return { dev: devKey(fields[2] ?? '', 10), root: decodeMountPath(fields[3] ?? ''), point: decodeMountPath(fields[4] ?? '') };
  });
}

/** A stacked mount on the owning root is ambiguous and cannot establish its filesystem path. */
export function locateOwnedRoot(path: string, mounts: readonly AliasMount[], budget = new AliasWorkBudget()): OwnedMountRoot {
  if (!pathValid(path)) throw new Error('invalid owned root');
  let mount: AliasMount | undefined;
  let ambiguous = false;
  for (const item of mounts) {
    budget.spend();
    if (suffix(path, item.point) === undefined) continue;
    if (!mount || item.point.length > mount.point.length) { mount = item; ambiguous = false; }
    else if (item.point === mount.point) ambiguous = true;
  }
  if (!mount || ambiguous) throw new Error('ambiguous owning mount');
  return { path, dev: mount.dev, fsPath: posix.join(mount.root, suffix(path, mount.point)!) };
}

export function indexAliasMounts(mounts: readonly AliasMount[], budget: AliasWorkBudget): Map<string, AliasMount[]> {
  const result = new Map<string, AliasMount[]>();
  for (const mount of mounts) {
    budget.spend();
    const entries = result.get(mount.dev) ?? [];
    entries.push(mount); result.set(mount.dev, entries);
  }
  return result;
}

/** Return candidate paths only. A caller must independently compare pinned inode/device
 * and recheck root, mount, namespace and process identity before signalling. */
export function aliasCandidates(path: string, targetRoot: string, deviceHex: string,
  targetMounts: readonly AliasMount[], owned: readonly OwnedMountRoot[], budget = new AliasWorkBudget(), index?: ReadonlyMap<string, readonly AliasMount[]>): string[] {
  if (!pathValid(path) || !pathValid(targetRoot)) throw new Error('ambiguous reader or target path');
  const device = devKey(deviceHex, 16);
  const candidates = new Set<string>();
  for (const mount of index?.get(device) ?? (index ? [] : targetMounts)) {
    budget.spend();
    if (mount.dev !== device) continue;
    const readerPoint = posix.join(targetRoot, mount.point);
    const relative = suffix(path, readerPoint);
    if (relative === undefined) continue;
    const fsPath = posix.join(mount.root, relative);
    for (const root of owned) {
      budget.spend();
      if (root.dev !== device) continue;
      const relativeOwned = suffix(fsPath, root.fsPath);
      if (relativeOwned === undefined) continue;
      const candidate = posix.join(root.path, relativeOwned);
      if (!pathValid(candidate)) throw new Error('invalid candidate');
      candidates.add(candidate);
      if (candidates.size > MAX_CANDIDATES) throw new Error('too many alias candidates');
    }
  }
  return [...candidates];
}

export interface MappedAliasCandidate { path: string; dev: string; ino: bigint }

/** proc cwd and fd links use a deleted suffix which can also be a literal
 * filename. A caller separately checks the link's stat and its stability. */
export function linkedAliasCandidates(path: string, targetRoot: string, deviceHex: string, ino: bigint,
  mounts: readonly AliasMount[], owned: readonly OwnedMountRoot[], budget = new AliasWorkBudget(), onCandidate?: () => void,
  index?: ReadonlyMap<string, readonly AliasMount[]>): MappedAliasCandidate[] {
  const forms = path.endsWith(' (deleted)') ? [path, path.slice(0, -10)] : [path];
  const lists = forms.map(form => {
    const candidates = aliasCandidates(form, targetRoot, deviceHex, mounts, owned, budget, index);
    if (candidates.length) onCandidate?.();
    return candidates;
  });
  if (lists.some(list => JSON.stringify(list) !== JSON.stringify(lists[0]))) throw new Error('ambiguous link path');
  return (lists[0] ?? []).map(candidate => ({ path: candidate, dev: devKey(deviceHex, 16), ino }));
}

/** Previously authenticated mappings remain scoped even after their alias mount
 * disappears. This is retention evidence only; it cannot authorize a signal. */
export function scopedMappingStillPresent(content: string, identities: readonly Pick<MappedAliasCandidate, 'dev' | 'ino'>[], budget = new AliasWorkBudget()): boolean {
  if (Buffer.byteLength(content) > MAX_BYTES || identities.length > MAX_CANDIDATES) throw new Error('mapping evidence exceeds bounds');
  const wanted = new Set(identities.map(identity => identity.dev + ':' + identity.ino));
  const lines = content.split('\n');
  if (lines.length > 65_536) throw new Error('mapping evidence exceeds bounds');
  let present = false;
  for (const line of lines) {
    budget.spend();
    if (!line) continue;
    const match = /^[0-9a-f]+-[0-9a-f]+\s+\S+\s+[0-9a-f]+\s+([0-9a-f]+:[0-9a-f]+)\s+(\d+)(?:\s+.*)?$/i.exec(line);
    if (!match || match[2]!.length > 20) throw new Error('malformed maps evidence');
    if (wanted.has(devKey(match[1]!, 16) + ':' + BigInt(match[2]!).toString())) present = true;
  }
  return present;
}

/** Parse exact map identities. Unknown paths remain unknown: an escaped newline
 * or deleted suffix has multiple interpretations in Linux maps. */
export function mappedAliasCandidates(content: string, targetRoot: string,
  targetMounts: readonly AliasMount[], owned: readonly OwnedMountRoot[], budget = new AliasWorkBudget(), onCandidate?: () => void): MappedAliasCandidate[] {
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('maps evidence exceeds bounds');
  const lines = content.split('\n');
  if (lines.length > 65_536) throw new Error('maps evidence exceeds bounds');
  const result: MappedAliasCandidate[] = [];
  const index = indexAliasMounts(targetMounts, budget);
  for (const line of lines) {
    budget.spend();
    if (!line) continue;
    const match = /^[0-9a-f]+-[0-9a-f]+\s+\S+\s+[0-9a-f]+\s+([0-9a-f]+:[0-9a-f]+)\s+(\d+)(?:\s+(.*))?$/i.exec(line);
    if (!match || match[2]!.length > 20) throw new Error('malformed maps evidence');
    const raw = match[3];
    if (!raw || !raw.startsWith('/') || match[2] === '0') continue;
    // Keep the interpretations separate; silently choosing one can misidentify a file.
    const forms = raw.endsWith(' (deleted)') ? [raw, raw.slice(0, -10)] : [raw];
    const variants = forms.flatMap(form => {
      const pieces = form.split('\\012');
      let paths = [pieces[0]!];
      for (const piece of pieces.slice(1)) {
        budget.spend(paths.length * 2);
        paths = paths.flatMap(value => [value + '\\012' + piece, value + '\n' + piece]);
        if (paths.length > MAX_CANDIDATES) throw new Error('maps path ambiguity exceeds bounds');
      }
      return paths;
    });
    const lists = variants.map(path => {
      const candidates = aliasCandidates(path, targetRoot, match[1]!, targetMounts, owned, budget, index);
      if (candidates.length) onCandidate?.();
      return candidates;
    });
    if (lists.some(list => JSON.stringify(list) !== JSON.stringify(lists[0]))) throw new Error('ambiguous mapped path');
    for (const path of lists[0] ?? []) {
      result.push({ path, dev: devKey(match[1]!, 16), ino: BigInt(match[2]!) });
      if (result.length > MAX_CANDIDATES) throw new Error('maps candidates exceed bounds');
    }
  }
  return result;
}
