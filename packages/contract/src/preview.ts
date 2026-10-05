import { z } from 'zod';

/**
 * Live preview v1 (#781, spec 2026-10-02-live-preview-v1): the agent tool's request and result, the
 * run-record entry a registration leaves behind, and both directions of the preview WebSocket.
 * Everything here is Node-free; the server and the cockpit read the same definitions.
 */

/** `cezar_preview_serve` input. `cwd` is relative to the worktree root; the server enforces that. */
export const previewServeRequestSchema = z.object({
  command: z.string().min(1).max(1024),
  port: z.number().int().min(1).max(65535),
  cwd: z.string().optional(),
  label: z.string().min(1).max(48).optional(),
  path: z.string().startsWith('/').optional(),
});
export type PreviewServeRequest = z.infer<typeof previewServeRequestSchema>;

export const previewResultCodeSchema = z.enum([
  'registered',
  'replaced',
  'invalid_input',
  'cwd_outside_worktree',
  'cezar_port',
  'port_held',
  'too_many',
  'preview_disabled',
  'headless',
  'worktree_missing',
  'unavailable',
]);
export type PreviewResultCode = z.infer<typeof previewResultCodeSchema>;

/** Every result carries a recovery hint: what the agent does next, in one step. */
export const previewServeResultSchema = z.object({
  ok: z.boolean(),
  code: previewResultCodeSchema,
  message: z.string(),
  hint: z.string(),
});
export type PreviewServeResult = z.infer<typeof previewServeResultSchema>;

/** Agent control carries no run identity or command: both come from its capability and approval. */
export const previewStopRequestSchema = z.object({
  port: z.number().int().min(1).max(65535),
  restart: z.boolean().optional(),
}).strict();
export type PreviewStopRequest = z.infer<typeof previewStopRequestSchema>;
export const previewStopResultSchema = z.object({
  ok: z.boolean(),
  code: z.enum(['stopped', 'restarted', 'approval_required', 'adopted', 'not_registered', 'port_held', 'port_in_use', 'invalid_input', 'preview_disabled', 'headless', 'worktree_missing', 'unavailable']),
  message: z.string(),
  hint: z.string(),
});
export type PreviewStopResult = z.infer<typeof previewStopResultSchema>;

/**
 * One registered dev server, as the run record keeps it. `answeredAtRegistration` is a single TCP
 * probe at registration: a historical observation, never a promise that Open runs nothing.
 */
export const previewServerSchema = z.object({
  port: z.number().int().min(1).max(65535),
  command: z.string(),
  cwd: z.string().optional(),
  label: z.string(),
  path: z.string().optional(),
  registeredAt: z.iso.datetime(),
  answeredAtRegistration: z.boolean(),
});
export type PreviewServer = z.infer<typeof previewServerSchema>;

/** The states a registration reports on the `preview.server-state` run event and on its card. */
export const previewServerStateSchema = z.enum([
  'registered',
  'starting',
  'up',
  'stalled',
  'exited',
  'stopped',
  'adopted',
  'unavailable',
]);
export type PreviewServerState = z.infer<typeof previewServerStateSchema>;

const port = z.number().int().min(1).max(65535);
const clampViewport = (value: number) => Math.min(4000, Math.max(100, Math.round(value)));

/** Mouse and key vocabularies are the prototype's: CDP's own names, nothing else gets through. */
export const previewMouseTypeSchema = z.enum(['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel']);
export const previewMouseButtonSchema = z.enum(['left', 'middle', 'right', 'none']);
export const previewKeyTypeSchema = z.enum(['keyDown', 'rawKeyDown', 'keyUp']);

/** Client to server. A whitelist: a message outside it is dropped and logged once per connection. */
export const previewClientMessageSchema = z.discriminatedUnion('t', [
  /** Never spawns anything: a silent port answers with `needs-approval`. */
  z.object({
    t: z.literal('open'),
    target: z.union([z.object({ port }), z.object({ url: z.string().min(1).max(2048) })]),
  }),
  /** The owner's explicit approval; the only message that runs a registered command. */
  z.object({ t: z.literal('run'), port }),
  z.object({ t: z.literal('stop'), port }),
  z.object({ t: z.literal('keepWaiting'), port }),
  z.object({
    t: z.literal('resize'),
    w: z.number().finite().transform(clampViewport),
    h: z.number().finite().transform(clampViewport),
  }),
  z.object({
    t: z.literal('mouse'),
    type: previewMouseTypeSchema,
    x: z.number().finite(),
    y: z.number().finite(),
    button: previewMouseButtonSchema.optional(),
    buttons: z.number().optional(),
    clickCount: z.number().optional(),
    deltaX: z.number().optional(),
    deltaY: z.number().optional(),
    modifiers: z.number().optional(),
  }),
  z.object({
    t: z.literal('key'),
    type: previewKeyTypeSchema,
    key: z.string().optional(),
    code: z.string().optional(),
    text: z.string().optional(),
    modifiers: z.number().optional(),
    vk: z.number().optional(),
    commands: z.array(z.string()).optional(),
  }),
  z.object({ t: z.literal('insertText'), text: z.string() }),
  z.object({ t: z.literal('nav'), url: z.string().min(1).max(2048) }),
  z.object({ t: z.literal('back') }),
  z.object({ t: z.literal('forward') }),
  z.object({ t: z.literal('reload'), ignoreCache: z.boolean().optional() }),
  z.object({ t: z.literal('dialogResult'), accept: z.boolean(), text: z.string().optional() }),
  z.object({ t: z.literal('ack') }),
  z.object({ t: z.literal('ping'), ts: z.number() }),
  z.object({ t: z.literal('download') }),
  z.object({ t: z.literal('cancelDownload') }),
  z.object({ t: z.literal('retryBrowser') }),
]);
export type PreviewClientMessage = z.infer<typeof previewClientMessageSchema>;

/**
 * The pane's server-driven states (design 5.1 to 5.10, 5.15 to 5.18). Connection lost (5.11), taken
 * over (5.12) and proxy blocked (5.14) are client transport states, not server stages.
 */
export const previewStateMessageSchema = z.discriminatedUnion('stage', [
  z.object({ t: z.literal('state'), stage: z.literal('chromium-missing'), installCommand: z.string(), canDownload: z.boolean() }),
  z.object({ t: z.literal('state'), stage: z.literal('downloading'), received: z.number(), total: z.number() }),
  z.object({ t: z.literal('state'), stage: z.literal('download-failed'), error: z.string(), installCommand: z.string() }),
  z.object({ t: z.literal('state'), stage: z.literal('sandbox-failed'), stderrTail: z.string() }),
  z.object({
    t: z.literal('state'),
    stage: z.literal('browser-exited'),
    signal: z.string().optional(),
    stderrTail: z.string(),
    serverUp: z.boolean(),
  }),
  z.object({ t: z.literal('state'), stage: z.literal('needs-approval'), server: previewServerSchema, wasRunning: z.boolean() }),
  /** Another task's cezar-owned server holds the port: never adopted, never spawned onto. Its title only, never its path. */
  z.object({ t: z.literal('state'), stage: z.literal('port-held'), server: previewServerSchema, ownerTitle: z.string() }),
  z.object({
    t: z.literal('state'),
    stage: z.literal('server-starting'),
    server: previewServerSchema,
    attempt: z.number().int(),
    startedAt: z.iso.datetime(),
    /** The newest lines the command printed, oldest first; empty before it prints anything. */
    logTail: z.array(z.string()),
  }),
  z.object({ t: z.literal('state'), stage: z.literal('server-stalled'), server: previewServerSchema, logTail: z.string() }),
  z.object({
    t: z.literal('state'),
    stage: z.literal('server-exited'),
    server: previewServerSchema,
    /** `null` when a signal ended the process. */
    exitCode: z.number().int().nullable(),
    logTail: z.string(),
  }),
  z.object({
    t: z.literal('state'),
    stage: z.literal('server-stopped'),
    server: previewServerSchema,
    reason: z.enum(['user', 'idle']),
    lastUrl: z.string(),
  }),
  z.object({ t: z.literal('state'), stage: z.literal('worktree-removed'), server: previewServerSchema.optional() }),
  z.object({ t: z.literal('state'), stage: z.literal('loading'), step: z.enum(['browser', 'page', 'frame']) }),
  z.object({ t: z.literal('state'), stage: z.literal('streaming'), adopted: z.boolean() }),
]);

/** Server to client JSON messages. JPEG frames travel as binary and have no schema here. */
export const previewServerMessageSchema = z.discriminatedUnion('t', [
  previewStateMessageSchema,
  z.object({ t: z.literal('url'), url: z.string() }),
  z.object({ t: z.literal('cursor'), cursor: z.string() }),
  z.object({
    t: z.literal('dialog'),
    type: z.enum(['alert', 'confirm', 'prompt', 'beforeunload']),
    message: z.string(),
    defaultPrompt: z.string().optional(),
    origin: z.string(),
  }),
  z.object({ t: z.literal('replaced'), by: z.string() }),
  z.object({ t: z.literal('pong'), ts: z.number() }),
  z.object({ t: z.literal('downloadProgress'), received: z.number(), total: z.number() }),
]);
export type PreviewServerMessage = z.infer<typeof previewServerMessageSchema>;
export type PreviewStateMessage = z.infer<typeof previewStateMessageSchema>;
