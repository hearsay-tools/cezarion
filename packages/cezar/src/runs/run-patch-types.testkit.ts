import { setRunStatus } from './run-store.testkit.ts';
import type { RunStore } from './store.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunPatch } from './run-exits.ts';

// @ts-expect-error Status writes belong to exits, not a run patch.
const statusPatch: RunPatch = { status: RUN_STATUS.running };
void statusPatch;

function refusesStatus(store: RunStore): void {
  // @ts-expect-error A run status can only be written by an exit or the testkit helper.
  store.updateRun('fixture', { status: RUN_STATUS.running });
}
void refusesStatus;

function refusesWaitFields(store: RunStore): void {
  // @ts-expect-error Wait fields belong to wait commits, not literal run patches.
  const waitsLiteral: RunPatch = { waits: [] };
  void waitsLiteral;
  const waitsVariable = { error: 'fixture', waits: [] };
  // @ts-expect-error Another valid field cannot admit a wait field.
  const waitsPatch: RunPatch = waitsVariable;
  void waitsPatch;
  // @ts-expect-error exactOptionalPropertyTypes rejects an explicitly undefined wait field.
  const waitsUndefined: RunPatch = { waits: undefined };
  void waitsUndefined;
  // @ts-expect-error Status fixture extras cannot write waits either.
  setRunStatus(store, 'fixture', RUN_STATUS.running, { waits: [] });
  // @ts-expect-error Another valid extra cannot admit a wait field.
  setRunStatus(store, 'fixture', RUN_STATUS.running, waitsVariable);
  // @ts-expect-error Clearing a wait field also belongs to seedWaits.
  setRunStatus(store, 'fixture', RUN_STATUS.running, { waits: undefined });
  // @ts-expect-error Wait fields belong to wait commits, not literal run patches.
  const lastWaitsLiteral: RunPatch = { lastWaits: [] };
  void lastWaitsLiteral;
  const lastWaitsVariable = { error: 'fixture', lastWaits: [] };
  // @ts-expect-error Another valid field cannot admit a wait field.
  const lastWaitsPatch: RunPatch = lastWaitsVariable;
  void lastWaitsPatch;
  // @ts-expect-error exactOptionalPropertyTypes rejects an explicitly undefined wait field.
  const lastWaitsUndefined: RunPatch = { lastWaits: undefined };
  void lastWaitsUndefined;
  // @ts-expect-error Status fixture extras cannot write waits either.
  setRunStatus(store, 'fixture', RUN_STATUS.running, { lastWaits: [] });
  // @ts-expect-error Another valid extra cannot admit a wait field.
  setRunStatus(store, 'fixture', RUN_STATUS.running, lastWaitsVariable);
  // @ts-expect-error Clearing a wait field also belongs to seedWaits.
  setRunStatus(store, 'fixture', RUN_STATUS.running, { lastWaits: undefined });
}
void refusesWaitFields;
