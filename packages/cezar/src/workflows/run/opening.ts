import { atContinue, atStepOpen } from './launch-read-resolver.ts';
import type { AgentInput } from '@open-mercato/cezar-contract/delegation';
import type { ContentBlock } from '../../core/agent-runner.ts';
import type { PersistedAttachment } from '../pasted-content.ts';
import type { QuestionAnswerSource } from './worker-questions.ts';

export interface OpeningHost {
  answerSource(runId: string, input: AgentInput): QuestionAnswerSource | undefined;
  readPersistedAttachments(runId: string, urls: string[], kind: 'task' | 'queued' | 'continuation'): { blocks: ContentBlock[]; attachments: PersistedAttachment[] };
}

/** Phase bindings preserve the existing opening call points. */
export const continuationOpening = atContinue.opening;
export const continuationImages = atContinue.openingImages;
export const openingInputs = atStepOpen.openingInputs;
