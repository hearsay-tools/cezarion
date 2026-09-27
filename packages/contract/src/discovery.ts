import { z } from 'zod';
import { modelDiscoveryRunnerSchema, providerStatusSchema, runnerModelCatalogResponseSchema, runnerModelOptionSchema } from './workspace.ts';

/** Host default-account discovery; delegation credentials select the controller, not an account. */
export const discoveryRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('runners') }).strict(),
  z.object({ kind: z.literal('models'), runner: modelDiscoveryRunnerSchema }).strict(),
]);
export type DiscoveryRequest = z.infer<typeof discoveryRequestSchema>;
export const discoveredRunnerSchema = providerStatusSchema.omit({ provider: true, profileId: true }).extend({ runner: modelDiscoveryRunnerSchema });
export const discoveredRunnersSchema = z.object({
  scope: z.literal('host-default-account'),
  runners: z.array(discoveredRunnerSchema),
});
export type DiscoveredRunners = z.infer<typeof discoveredRunnersSchema>;
export const discoveryResponseSchema = z.union([discoveredRunnersSchema, runnerModelCatalogResponseSchema]);
export type DiscoveryResponse = z.infer<typeof discoveryResponseSchema>;

export const modelChoicesSchema = z.object({
  runner: modelDiscoveryRunnerSchema,
  requestedModel: z.string(),
  availableModels: z.array(runnerModelOptionSchema),
  otherRunners: z.array(modelDiscoveryRunnerSchema),
});
export type ModelChoices = z.infer<typeof modelChoicesSchema>;
