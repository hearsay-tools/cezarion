import { capabilitiesSchema, healthResponseSchema } from '@open-mercato/cezar-api-client/contract/health'

/**
 * Health as the cockpit accepts it from a server of any version. The contract describes the
 * current server's wire exactly, so each capability it adds is required there. An older server
 * omits the newer ones, and the cockpit reads an absent capability as off
 * (BACKWARD_COMPATIBILITY.md §2), so a parse here takes every capability as optional. Every
 * other field keeps the contract's rule.
 */
export const healthPayloadSchema = healthResponseSchema.extend({ capabilities: capabilitiesSchema.partial() })
