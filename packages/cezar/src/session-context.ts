import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Session-start context injection (hearsay-tools/cezarion#1584, docs/context-injection.md).
 *
 * Every cezar-managed launch — a fresh step, a check retry, Continue, recovery, an owned
 * worker — opens with a prefix of labeled blocks before the task: the run's whole handoff
 * first, then the project's optional `.ai/cezar/context.yaml` rules in file order. Inputs are
 * read again for each launch; the rendered prefix is fixed for that launch. Nothing here
 * throws: every failure skips the block it affects and says why in the reports.
 */

/** The complete injection prefix — labels and separators included — counted in UTF-8 bytes. */
export const SESSION_CONTEXT_LIMIT_BYTES = 65_536;
/** Project rules, relative to the project root. Optional: absent means no custom rules. */
export const SESSION_CONTEXT_FILE = '.ai/cezar/context.yaml';
/** The built-in handoff block's id; a custom rule cannot take it. */
export const HANDOFF_CONTEXT_ID = 'handoff';
/** Divides the prefix from the opening message. */
export const SESSION_CONTEXT_SEPARATOR = '\n\n---\n\n';

/** Variables a template may name; `{{file:<path>}}` is the one other token form. */
export const SESSION_CONTEXT_VARIABLES = [
  'task', 'run.id', 'role', 'workflow.name', 'step.id', 'project.root', 'worktree.root', 'handoff.path',
] as const;
export type SessionContextVariable = typeof SESSION_CONTEXT_VARIABLES[number];

export type SessionContextRole = 'parent' | 'worker';

export interface SessionContextRule {
  id: string;
  target: 'parent' | 'worker' | 'both';
  template: string;
}

/** One rule's outcome for one launch. `applied` means "in the launch prompt", not "delivered". */
export interface SessionContextReport {
  id: string;
  status: 'applied' | 'skipped';
  /** Files the block read: the handoff's absolute path, or a rule's paths as written. */
  sources: string[];
  /** UTF-8 bytes of the block as rendered, when it was rendered. */
  bytes?: number;
  reason?: string;
}

export interface SessionContext {
  /** The prefix to put in front of the opening message, separator included; `''` for none. */
  prefix: string;
  /** Whether the handoff block made it in — when not, the agent keeps the read instruction. */
  handoffInjected: boolean;
  reports: SessionContextReport[];
}

const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;
/** A larger config file is refused unread. */
const CONFIG_LIMIT_BYTES = 256 * 1024;
const CONFIG_REPORT_ID = 'context.yaml';

const ruleSchema = z.object({
  id: z.string().regex(RULE_ID, 'id must be 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit'),
  on: z.literal('session_start', { error: 'on must be session_start' }),
  target: z.enum(['parent', 'worker', 'both']).default('both'),
  template: z.string().min(1, 'template must not be empty'),
}).strict();

type ReadResult = { ok: true; text: string } | { ok: false; reason: string; missing?: boolean };

/** Read at most `limit` bytes of strict UTF-8; a larger file is refused, never truncated. */
function readBoundedUtf8(path: string, limit: number): ReadResult {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size > limit) return { ok: false, reason: `larger than ${limit} bytes` };
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buffer, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, read)) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: 'not found', missing: true };
    if (error instanceof TypeError) return { ok: false, reason: 'not valid UTF-8' };
    return { ok: false, reason: code === 'EISDIR' ? 'is a directory' : `unreadable (${code ?? 'error'})` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Read and validate the project's rules. A missing file is no rules and no warning; a file that
 * cannot be read or parsed, or has another version, skips every custom rule with one report;
 * a bad, duplicate or reserved rule skips that rule alone.
 */
export function loadSessionContextRules(projectRoot: string): { rules: SessionContextRule[]; reports: SessionContextReport[] } {
  const file = readBoundedUtf8(join(projectRoot, SESSION_CONTEXT_FILE), CONFIG_LIMIT_BYTES);
  if (!file.ok) {
    return file.missing ? { rules: [], reports: [] } : { rules: [], reports: [configSkip(file.reason)] };
  }
  let doc: unknown;
  try {
    doc = parseYaml(file.text);
  } catch (error) {
    return { rules: [], reports: [configSkip(`invalid YAML: ${oneLine(error instanceof Error ? error.message : String(error))}`)] };
  }
  if (doc === null || doc === undefined) return { rules: [], reports: [] };
  if (typeof doc !== 'object' || Array.isArray(doc)) return { rules: [], reports: [configSkip('expected a mapping with version and rules')] };
  const { version, rules } = doc as { version?: unknown; rules?: unknown };
  if (version !== 1) return { rules: [], reports: [configSkip(`unsupported version ${JSON.stringify(version ?? null)}; expected 1`)] };
  if (rules === undefined || rules === null) return { rules: [], reports: [] };
  if (!Array.isArray(rules)) return { rules: [], reports: [configSkip('rules must be a list')] };

  return validateRules(rules);
}

/** Each rule on its own: one bad, duplicate or reserved rule never takes the others down. */
function validateRules(rules: unknown[]): { rules: SessionContextRule[]; reports: SessionContextReport[] } {
  const reports: SessionContextReport[] = [];
  const parsed: Array<SessionContextRule | undefined> = rules.map((raw, index) => {
    const rawId = raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id : undefined;
    const label = rawId && RULE_ID.test(rawId) ? rawId : `rules[${index}]`;
    const result = ruleSchema.safeParse(raw);
    if (!result.success) {
      reports.push(skip(label, `invalid rule: ${oneLine(result.error.issues.map((issue) => `${issue.path.join('.') || 'rule'}: ${issue.message}`).join('; '))}`));
      return undefined;
    }
    if (result.data.id === HANDOFF_CONTEXT_ID) {
      reports.push(skip(label, `id "${HANDOFF_CONTEXT_ID}" is reserved for the built-in handoff`));
      return undefined;
    }
    return { id: result.data.id, target: result.data.target, template: result.data.template };
  });
  // A duplicated id is ambiguous: skip every rule that carries it, not just the later ones.
  const counts = new Map<string, number>();
  for (const rule of parsed) if (rule) counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
  const valid: SessionContextRule[] = [];
  for (const rule of parsed) {
    if (!rule) continue;
    if ((counts.get(rule.id) ?? 0) > 1) reports.push(skip(rule.id, 'duplicate id'));
    else valid.push(rule);
  }
  return { rules: valid, reports };
}

export interface SessionContextInput {
  projectRoot: string;
  /** The receiving session's working directory: where `{{file:…}}` paths resolve. */
  cwd: string;
  role: SessionContextRole;
  handoffPath: string;
  variables: Partial<Record<SessionContextVariable, string>>;
}

/** Build one launch's prefix: read the handoff and the rules now, render for this recipient. */
export function buildSessionContext(input: SessionContextInput): SessionContext {
  const reports: SessionContextReport[] = [];
  const blocks: string[] = [];
  let handoffInjected = false;
  const fits = (block: string) =>
    Buffer.byteLength([...blocks, block].join('\n\n') + SESSION_CONTEXT_SEPARATOR, 'utf8') <= SESSION_CONTEXT_LIMIT_BYTES;

  const handoff = readBoundedUtf8(input.handoffPath, SESSION_CONTEXT_LIMIT_BYTES);
  if (!handoff.ok) {
    reports.push({ ...skip(HANDOFF_CONTEXT_ID, handoff.reason), sources: [input.handoffPath] });
  } else {
    const block = renderBlock(HANDOFF_CONTEXT_ID, handoff.text, input.handoffPath);
    const bytes = Buffer.byteLength(block, 'utf8');
    if (fits(block)) {
      blocks.push(block);
      handoffInjected = true;
      reports.push({ id: HANDOFF_CONTEXT_ID, status: 'applied', sources: [input.handoffPath], bytes });
    } else {
      reports.push({ ...skip(HANDOFF_CONTEXT_ID, `does not fit the ${SESSION_CONTEXT_LIMIT_BYTES}-byte limit`), sources: [input.handoffPath], bytes });
    }
  }

  const loaded = loadSessionContextRules(input.projectRoot);
  reports.push(...loaded.reports);
  for (const rule of loaded.rules) {
    if (rule.target !== 'both' && rule.target !== input.role) continue;
    const rendered = renderTemplate(rule.template, input);
    if (!rendered.ok) {
      reports.push({ ...skip(rule.id, rendered.reason), sources: rendered.sources });
      continue;
    }
    const block = renderBlock(rule.id, rendered.text);
    const bytes = Buffer.byteLength(block, 'utf8');
    if (!fits(block)) {
      reports.push({ ...skip(rule.id, `does not fit the ${SESSION_CONTEXT_LIMIT_BYTES}-byte limit`), sources: rendered.sources, bytes });
      continue;
    }
    blocks.push(block);
    reports.push({ id: rule.id, status: 'applied', sources: rendered.sources, bytes });
  }
  return { prefix: blocks.length ? blocks.join('\n\n') + SESSION_CONTEXT_SEPARATOR : '', handoffInjected, reports };
}

/** The one lifecycle line a launch reports: each block's outcome, never its contents. */
export function formatSessionContextReport(reports: readonly SessionContextReport[]): string {
  const parts = reports.map((report) => {
    const detail = [report.bytes !== undefined ? `${report.bytes} B` : undefined, ...report.sources].filter(Boolean).join(', ');
    return `${report.id} ${report.status}${detail ? ` (${detail})` : ''}${report.reason ? ` — ${report.reason}` : ''}`;
  });
  return `session context: ${parts.length ? parts.join('; ') : 'nothing to inject'}`;
}

function renderBlock(id: string, body: string, source?: string): string {
  const attrs = source ? ` id="${id}" source="${escapeAttribute(source)}"` : ` id="${id}"`;
  return `<cezar-context${attrs}>\n${body.replace(/\n+$/, '')}\n</cezar-context>`;
}

type Rendered = { ok: true; text: string; sources: string[] } | { ok: false; reason: string; sources: string[] };

/**
 * Expand a template in one pass over the template text only: a value or file content that
 * holds `{{…}}` stays literal. Every token is resolved before anything is emitted, so one bad
 * token skips the whole rule instead of shipping a half-rendered block.
 */
function renderTemplate(template: string, input: SessionContextInput): Rendered {
  const sources: string[] = [];
  const values: string[] = [];
  for (const match of template.matchAll(TOKEN)) {
    const token = match[1]!;
    if (token.startsWith('file:')) {
      const path = token.slice('file:'.length).trim();
      sources.push(path);
      const file = readIncludedFile(input.cwd, path);
      if (!file.ok) return { ok: false, reason: `file ${path}: ${file.reason}`, sources };
      values.push(file.text);
      continue;
    }
    if (!(SESSION_CONTEXT_VARIABLES as readonly string[]).includes(token)) {
      return { ok: false, reason: `unknown variable {{${token}}}`, sources };
    }
    const value = input.variables[token as SessionContextVariable];
    if (value === undefined) return { ok: false, reason: `variable {{${token}}} is not available for this launch`, sources };
    values.push(value);
  }
  let index = 0;
  return { ok: true, text: template.replace(TOKEN, () => values[index++]!), sources };
}

/** A relative path inside the receiving worktree, symlinks resolved; anything else is refused. */
function readIncludedFile(cwd: string, path: string): ReadResult {
  if (!path) return { ok: false, reason: 'empty path' };
  if (isAbsolute(path)) return { ok: false, reason: 'absolute paths are not allowed' };
  let root: string;
  let target: string;
  try {
    root = realpathSync(cwd);
  } catch {
    return { ok: false, reason: 'the worktree is not readable' };
  }
  try {
    target = realpathSync(resolve(root, path));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { ok: false, reason: 'not found', missing: true }
      : { ok: false, reason: `unreadable (${(error as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  const inside = relative(root, target);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return { ok: false, reason: 'outside the worktree' };
  return readBoundedUtf8(target, SESSION_CONTEXT_LIMIT_BYTES);
}

function configSkip(reason: string): SessionContextReport {
  return { id: CONFIG_REPORT_ID, status: 'skipped', sources: [SESSION_CONTEXT_FILE], reason: `${reason}; custom rules skipped` };
}

function skip(id: string, reason: string): SessionContextReport {
  return { id, status: 'skipped', sources: [], reason };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
