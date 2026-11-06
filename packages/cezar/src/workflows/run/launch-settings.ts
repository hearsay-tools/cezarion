import { createRunner } from '../../core/runner-factory.ts';
import type { RunnerId } from '../../core/agent-runner.ts';
import type { StepState } from '../../runs/store.ts';
import { atTaskHead, atStepOpen, atContinue } from './launch-read-resolver.ts';

/** Compatibility bindings for model/effort readers; selection is owned by the phase resolver. */
export const taskModelIdentity: typeof atTaskHead.modelIdentity = atTaskHead.modelIdentity;
export const stepModel: typeof atStepOpen.model = atStepOpen.model;
export const stepEffort: typeof atStepOpen.effort = atStepOpen.effort;
export const continuationModel: typeof atContinue.model = atContinue.model;
export const continuationEffort: typeof atContinue.effort = atContinue.effort;
export function continuationRunner(backend: RunnerId, sessionId: string | undefined, owningStep: StepState | undefined): ReturnType<typeof atContinue.runner> {
  return atContinue.runner(backend, sessionId, owningStep, createRunner);
}
