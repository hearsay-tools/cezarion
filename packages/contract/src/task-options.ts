import { z } from 'zod';

/** Opt-in completion controls on a run and its start, patch and automation inputs. Missing values are off. */
export const completionControlsShape = {
  archiveWhenDone: z.boolean().optional(),
  autoMergePr: z.boolean().optional(),
};

/** Task access (hearsay-tools/cezarion#2784): may the task's agents start and resume Squawk workers,
 *  and message peer tasks. New runs store an explicit value; a missing value is on. */
export const taskAccessShape = {
  allowWorkers: z.boolean().optional(),
  allowMessaging: z.boolean().optional(),
};

export const workersAllowed = (run: { allowWorkers?: boolean | undefined }): boolean => run.allowWorkers !== false;
export const messagingAllowed = (run: { allowMessaging?: boolean | undefined }): boolean => run.allowMessaging !== false;
