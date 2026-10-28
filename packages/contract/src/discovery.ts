import { z } from 'zod';
import { runnerSchema } from './health.ts';
import { modelDiscoveryRunnerSchema, providerStatusSchema, runnerModelCatalogResponseSchema, runnerModelOptionSchema } from './workspace.ts';

/** Host default-account discovery; delegation credentials select the controller, not an account. */
export const hostDiscoveryRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('runners') }).strict(),
  z.object({ kind: z.literal('models'), runner: modelDiscoveryRunnerSchema }).strict(),
]);
export const discoveryRequestSchema = z.discriminatedUnion('kind', [
  ...hostDiscoveryRequestSchema.options,
  z.object({ kind: z.literal('tasks'), all: z.boolean().optional(), offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() }).strict(),
]);
export type DiscoveryRequest = z.infer<typeof discoveryRequestSchema>;
export const discoveredRunnerSchema = providerStatusSchema.omit({ provider: true, profileId: true }).extend({ runner: modelDiscoveryRunnerSchema });
export const discoveredRunnersSchema = z.object({
  scope: z.literal('host-default-account'),
  runners: z.array(discoveredRunnerSchema),
});
export type DiscoveredRunners = z.infer<typeof discoveredRunnersSchema>;
export const discoveredTasksSchema = z.object({
  tasks: z.array(z.object({
    id: z.string(), title: z.string(), runner: runnerSchema.optional(),
    status: z.enum(['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled']),
    attention: z.enum(['permission', 'error', 'waiting', 'running', 'unseen', 'none']),
    attentionLabel: z.string(), accepts: z.boolean(), reason: z.string().optional(),
  })).max(32),
  nextOffset: z.number().int().nonnegative().optional(),
});
export type DiscoveredTasks = z.infer<typeof discoveredTasksSchema>;
export const discoveryResponseSchema = z.union([discoveredRunnersSchema, runnerModelCatalogResponseSchema, discoveredTasksSchema]);
export type DiscoveryResponse = z.infer<typeof discoveryResponseSchema>;

export const modelChoicesSchema = z.object({
  runner: modelDiscoveryRunnerSchema,
  requestedModel: z.string(),
  availableModels: z.array(runnerModelOptionSchema),
  otherRunners: z.array(modelDiscoveryRunnerSchema),
});
export type ModelChoices = z.infer<typeof modelChoicesSchema>;
