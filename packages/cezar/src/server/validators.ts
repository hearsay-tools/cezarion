import type { Context, Env, MiddlewareHandler } from 'hono';
import { validator } from 'hono/validator';
import type { z } from 'zod';

/**
 * Route-middleware validators for JSON, params and queries. Preserve typed input/output and the
 * API’s JSON error boundary, including absent and malformed body policy.
 */

type ErrorOptions = {
  /** Fixed 400 text, for routes that answer one instead of the zod issues. */
  message?: string;
  /** Stable typed code for the dedicated delegation API. */
  code?: 'invalid_input';
};

type JsonOptions = ErrorOptions & {
  /**
   * What a request with NO body parses as — the old `.catch(() => …)` fallback. Hono hands a
   * bodyless request `{}`, which is not the same as a request that really sent `{}`: routes that
   * tolerate no body at all pass `{}` here, and the rest keep rejecting it exactly as they did.
   */
  absent?: unknown;
  /**
   * What a body that is PRESENT but not parseable as JSON becomes. Defaults to `absent`, which is
   * what every route wants when both cases are rejected anyway.
   *
   * Use distinct values when an optional body accepts absence but must reject malformed JSON.
   */
  malformed?: unknown;
  /**
   * Builds the rejection itself, from the issues and the parsed input. The private preview tool
   * route (#781) answers its agent a typed 200 result naming the field, not this API's 400.
   */
  invalid?: (c: Context, error: z.ZodError, input: unknown) => Response;
};

/**
 * `{ error }`, the one 400 shape this API answers (BACKWARD_COMPATIBILITY.md).
 *
 * Each issue is prefixed with the field path, because zod's own message never names the field:
 * `"Invalid input: expected array, received undefined"` on its own does not tell the cockpit user
 * WHICH field to fix. That is the same information `z.prettifyError` adds, minus its multi-line
 * `✖ …\n  → at task` layout — this string is rendered verbatim in a toast, so it stays one line.
 */
function reject(c: Context, error: z.ZodError, override: string | undefined, code?: 'invalid_input') {
  const detail = error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
  return c.json({ error: override ?? detail, ...(code ? { code } : {}) }, 400);
}

/**
 * The request/response split, spelled out rather than inferred.
 *
 * Hono derives a validator's request type from its validation function's first parameter, but
 * declares that parameter as a CONDITIONAL type — which is not an inference site, so annotating
 * it achieves nothing and the request silently falls back to the schema's OUTPUT. That makes any
 * `.optional().transform(…)` or `.default(…)` field REQUIRED on the wire: `POST /runs` demanded a
 * `systemPrompt` no caller should send, and `POST …/merge` demanded `overrideRules`. Naming both
 * sides here is the same thing `@hono/zod-validator` does, and for the same reason.
 */
type JsonValidator<S extends z.ZodType, E extends Env, P extends string> = MiddlewareHandler<
  E,
  P,
  { in: { json: z.input<S> }; out: { json: z.output<S> } }
>;

export function jsonZodValidator<
  S extends z.ZodType,
  E extends Env = Env,
  P extends string = string,
>(
  // A thunk is accepted because several schemas are declared next to the route family they
  // belong to, which is BELOW the route using them; resolving per request keeps those
  // declarations where they read best. Pass the schema directly whenever it is already in scope —
  // a GENERIC thunk is worse than either, since an unresolved schema type makes Hono drop the
  // route from the app type silently (see typed-bodies.test.ts).
  schema: S | (() => S),
  options: JsonOptions = {},
): JsonValidator<S, E, P> {
  // Key presence, not a destructuring default: `undefined` IS a meaningful value for both of
  // these; a `= null` default would silently overwrite an explicitly absent value.
  const absent = 'absent' in options ? options.absent : null;
  const malformed = 'malformed' in options ? options.malformed : absent;
  const { message, code, invalid } = options;
  const check = (input: unknown, c: Context) => {
    const resolved = typeof schema === 'function' ? schema() : schema;
    const parsed = resolved.safeParse(input);
    if (parsed.success) return { ok: true, data: parsed.data as z.infer<S> } as const;
    return { ok: false, response: invalid ? invalid(c, parsed.error, input) : reject(c, parsed.error, message, code) } as const;
  };

  const validate = validator('json', (value, c) => {
    const result = check(value, c);
    return result.ok ? result.data : result.response;
  });

  // Anything Hono would treat differently than the old inline parse is settled here and published
  // straight to `c.req.valid('json')`; only well-formed JSON under a JSON content-type — what
  // every real client sends — takes Hono's own path. See the header note.
  const guard: typeof validate = async (c, next) => {
    const text = await c.req.text().catch(() => '');
    let body: unknown = absent;
    let parseable = false;
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text);
        parseable = true;
      } catch {
        body = malformed;
      }
    }
    const contentType = c.req.header('content-type');
    if (parseable && contentType !== undefined && /^application\/([a-z\-.]+\+)?json/.test(contentType)) {
      return validate(c, next);
    }
    const result = check(body, c);
    if (!result.ok) return result.response;
    c.req.addValidatedData('json', result.data as never);
    return next();
  };
  return guard as unknown as JsonValidator<S, E, P>;
}

/**
 * Path params. No guard needed: these come off the matched URL, so there is no body to parse, no
 * content-type to gate on and no malformed-input path — Hono's own behaviour is already right.
 * The schema receives the whole param object (`{ provider: 'codex' }`), not a single value.
 */
export function paramZodValidator<S extends z.ZodType>(schema: S, { message, code }: ErrorOptions = {}) {
  return validator('param', (value, c) => {
    const parsed = schema.safeParse(value);
    return parsed.success ? (parsed.data as z.infer<S>) : reject(c, parsed.error, message, code);
  });
}

/** Query string, on the same terms as {@link paramZodValidator}. */
export function queryZodValidator<S extends z.ZodType>(schema: S, { message, code }: ErrorOptions = {}) {
  return validator('query', (value, c) => {
    const parsed = schema.safeParse(value);
    return parsed.success ? (parsed.data as z.infer<S>) : reject(c, parsed.error, message, code);
  });
}
