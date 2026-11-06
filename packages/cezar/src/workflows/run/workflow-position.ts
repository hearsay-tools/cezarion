import { atContinue } from './launch-read-resolver.ts';

/** Source reads stay at the existing workflow cursor and session-evidence call points. */
export const waitingBeforeFinalWorkflowStep = atContinue.waitingBeforeFinalWorkflowStep;
export const waitingWorkflowStepIndex = atContinue.waitingWorkflowStepIndex;
export const continuationNextStep = atContinue.continuationNextStep;
export const ciWorkflowResumeStepIndex = atContinue.ciWorkflowResumeStepIndex;
export const resumableSessionId = atContinue.resumableSessionId;
export const isSyntheticContinuation = atContinue.isSyntheticContinuation;
