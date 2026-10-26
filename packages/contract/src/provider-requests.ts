import { z } from 'zod';
import { runnerSchema } from './health.ts';
const PROVIDER_IDS = runnerSchema.options;

export const providerConnectSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  /** Which agent account to sign in (spec 2026-07-29-agent-profiles). Absent = the discovered
   *  default, which is what every pre-profiles client sends. Without this, "Connect" on a second
   *  Claude account would open a login for the FIRST one and report success. */
  profileId: z.string().max(64).optional(),
}).strict();

/** Agent-account bodies (spec 2026-07-29-agent-profiles). Bounds mirror `agentProfileSchema` in
 *  src/workspace/config.ts exactly, so a value these accept can never be degraded away by the
 *  next load's `.catch`. The id is allocated server-side and is never a request field. */
export const createAgentProfileSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  label: z.string().trim().max(200).optional(),
  configDir: z.string().trim().min(1).max(4096),
}).strict();

/** `POST …/agent-profiles/:id/open` — a catalog id (or `folder`) plus an optional open target. */
export const openAgentAccountFileSchema = z.object({
  file: z.string().min(1).max(200),
  target: z.string().min(1).max(64).optional(),
}).strict();

export const updateAgentProfileSchema = z.object({
  label: z.string().trim().max(200).optional(),
  configDir: z.string().trim().min(1).max(4096).optional(),
}).strict().refine(
  (value) => value.label !== undefined || value.configDir !== undefined,
  'send label or configDir',
);

/** `PUT …/agent-profiles/selection` — which account a project uses for one provider. `null`
 *  clears it back to the discovered account. */
export const selectAgentProfileSchema = z.object({
  /** `null` targets the machine-wide default rather than one repo. */
  projectId: z.string().min(1).max(64).nullable(),
  provider: z.enum(PROVIDER_IDS),
  profileId: z.string().max(64).nullable(),
}).strict();

export const providerParamSchema = z.enum(PROVIDER_IDS);

export const providerEnabledSchema = z.object({ enabled: z.boolean() }).strict();

export const providerRetrySchema = z.object({
  authFailureId: z.string().min(1).max(128),
}).strict();

export const providerRouteParamsSchema = z.object({ provider: providerParamSchema });

export const agentProfileRouteParamsSchema = z.object({ id: z.string() });
