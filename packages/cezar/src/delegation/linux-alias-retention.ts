import { z } from 'zod';
import { workerAliasRetentionSchema, type WorkerAliasRetention, type WorkerExecution } from '../runs/worker-execution.ts';
import { linuxDeviceNumber } from './linux-alias-identity.ts';
import { AliasMappingScope } from './linux-alias-scope.ts';
import type { AliasScanAttempt } from './linux-alias-scan.ts';

/** The caller checks assertCurrent before and after each private replacement. */
export function aliasRetentionAdapter(proof: WorkerExecution | undefined, resourceId: string, bootId: string | undefined,
  attempt: AliasScanAttempt, write: (value: WorkerAliasRetention | undefined) => void, verify: () => void): {
    scope: AliasMappingScope; publish: (entries: ReturnType<AliasMappingScope['snapshot']>) => void;
  } {
  if (!proof) throw new Error('Worker alias checkpoint unavailable');
  const validBoot = z.string().uuid().safeParse(bootId).success;
  const roots = attempt.roots.map((path, index) => {
    const identity = attempt.rootIdentities[index];
    if (identity === 'absent') return { path, identity: null };
    const match = /^(\d+):(\d+)$/.exec(identity ?? '');
    if (!match) throw new Error('Invalid owned root identity');
    return { path, identity: { dev: linuxDeviceNumber(BigInt(match[1]!)), ino: match[2]! } };
  });
  const scope = new AliasMappingScope();
  const prior = proof.aliasRetention;
  let last = JSON.stringify(prior ?? null);
  if (prior) {
    if (!validBoot) throw new Error('Worker alias boot identity unavailable');
    if (prior.generation !== proof.generation || prior.resourceId !== resourceId ||
        JSON.stringify(prior.roots) !== JSON.stringify(roots)) throw new Error('Worker alias retention identity changed');
    if (prior.bootId !== bootId) {
      // A verified new boot proves every old process incarnation has exited.
      verify();
      write(undefined);
      last = 'null';
    } else for (const item of prior.processes) {
      scope.remember(item.pid, bootId + ':' + item.start, item.identities.map(value => ({ dev: value.dev, ino: BigInt(value.ino) })));
    }
  }
  return { scope, publish(entries) {
    if (!entries.length) {
      if (last !== 'null') { write(undefined); last = 'null'; }
      return;
    }
    if (!validBoot) throw new Error('Worker alias boot identity unavailable');
    const processes = entries.map(entry => {
      const prefix = bootId + ':';
      if (!entry.token.startsWith(prefix)) throw new Error('Unscoped process incarnation');
      return { pid: entry.pid, start: entry.token.slice(prefix.length), identities: entry.identities };
    });
    const next = workerAliasRetentionSchema.parse({ generation: proof.generation, resourceId, bootId, roots, processes });
    const serialized = JSON.stringify(next);
    if (serialized !== last) { write(next); last = serialized; }
  } };
}
