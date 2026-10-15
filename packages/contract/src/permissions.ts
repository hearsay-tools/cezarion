/** Human permission decisions carry opaque IDs; only the runner owns native grants. */
import { z } from 'zod';

export const permissionOptionKindSchema = z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']);
export type PermissionOptionKind = z.infer<typeof permissionOptionKindSchema>;
export const permissionOptionSchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string().min(1),
  kind: permissionOptionKindSchema,
}).strict();
export type PermissionOption = z.infer<typeof permissionOptionSchema>;
export const permissionRequestedSchema = z.object({
  type: z.literal('permission.requested'),
  requestId: z.string().min(1).max(128),
  itemId: z.string().optional(),
  title: z.string().min(1),
  details: z.string().optional(),
  options: z.array(permissionOptionSchema).min(1).refine(options => new Set(options.map(option => option.id)).size === options.length),
}).strict();
export type PermissionRequest = z.infer<typeof permissionRequestedSchema>;
export const permissionResolvedSchema = z.object({
  type: z.literal('permission.resolved'),
  requestId: z.string().min(1).max(128),
  optionId: z.string().optional(),
  reason: z.string().optional(),
}).strict();
export type PermissionResolution = z.infer<typeof permissionResolvedSchema>;
export const permissionDecisionSchema = z.object({
  requestId: z.string().min(1).max(128),
  optionId: z.string().min(1).max(128),
}).strict();
export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;
export const permissionDecisionResponseSchema = z.object({ delivered: z.literal(true) });
export type PermissionDecisionResponse = z.infer<typeof permissionDecisionResponseSchema>;
