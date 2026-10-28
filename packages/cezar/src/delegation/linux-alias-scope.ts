import { AliasBudgetExceeded, AliasWorkBudget, scopedMappingStillPresent, type MappedAliasCandidate } from './linux-alias-model.ts';

/** A confirmed identity is useful only for retention. The caller must repeat
 * the complete authenticated path check before any signal. */
export class AliasMappingScope {
  private readonly entries = new Map<number, { token: string; identities: Pick<MappedAliasCandidate, 'dev' | 'ino'>[]; links: ScopedLink[] }>();

  has(pid: number): boolean { return this.entries.has(pid); }

  /** Serialize identities for retention only. The start token must include a
   * verified Linux boot ID before the caller writes this to a checkpoint. */
  snapshot(): { pid: number; token: string; identities: { dev: string; ino: string }[] }[] {
    return [...this.entries].map(([pid, entry]) => {
      const identities = new Map([...entry.identities, ...entry.links].map(identity =>
        [identity.dev + ':' + identity.ino, { dev: identity.dev, ino: identity.ino.toString() }]));
      return { pid, token: entry.token, identities: [...identities.values()] };
    });
  }

  remember(pid: number, token: string, identities: readonly Pick<MappedAliasCandidate, 'dev' | 'ino'>[]): void {
    if (!token || !identities.length || identities.length > 1024) throw new Error('invalid scoped mapping');
    const previous = this.entries.get(pid);
    const all = previous?.token === token ? [...previous.identities, ...identities] : [...identities];
    const unique = new Map(all.map(identity => [identity.dev + ':' + identity.ino, identity]));
    if (unique.size > 1024) throw new Error('scoped mappings exceed bounds');
    this.entries.set(pid, { token, identities: [...unique.values()], links: previous?.token === token ? previous.links : [] });
  }

  rememberLink(pid: number, token: string, link: ScopedLink): void {
    if (!token || !/^(cwd|fd\/[0-9]+)$/.test(link.handle)) throw new Error('invalid scoped link');
    const previous = this.entries.get(pid);
    const entry = previous?.token === token ? previous : { token, identities: [], links: [] };
    const links = new Map(entry.links.map(item => [item.handle + ':' + item.dev + ':' + item.ino, item]));
    links.set(link.handle + ':' + link.dev + ':' + link.ino, link);
    if (links.size > 1024) throw new Error('scoped links exceed bounds');
    this.entries.set(pid, { ...entry, links: [...links.values()] });
  }

  /** An unreadable token or maps is unknown; only an observed new incarnation,
   * confirmed exit, or readable maps without the identities releases the scope. */
  recheck(pid: number, token: string | undefined, maps: string | undefined, exited: boolean,
    links?: readonly ScopedLink[], budget = new AliasWorkBudget()): 'clear' | 'unknown' {
    const previous = this.entries.get(pid);
    if (!previous) return 'clear';
    if (exited || (token && token !== previous.token)) { this.entries.delete(pid); return 'clear'; }
    // A file may move from a descriptor to a mapping or back between scans.
    if (!token || maps === undefined || links === undefined) return 'unknown';
    try {
      const remembered = [...previous.identities, ...previous.links];
      if (remembered.length > 1024 || scopedMappingStillPresent(maps, remembered, budget)) return 'unknown';
      if (links.length > 1024) return 'unknown';
      budget.spend(links.length + remembered.length);
      const live = new Set(links.map(link => link.dev + ':' + link.ino));
      if (remembered.some(old => live.has(old.dev + ':' + old.ino))) return 'unknown';
    } catch (error) { budget.spend(0); if (error instanceof AliasBudgetExceeded) throw error; return 'unknown'; }
    this.entries.delete(pid);
    return 'clear';
  }
}

/** Only a complete, stable scan may report an absent handle. */
export interface ScopedLink { handle: string; dev: string; ino: bigint }
