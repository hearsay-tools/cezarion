/**
 * Bounds a project's name, tags and webhook, shared by its schemas, the registry and the cockpit.
 *
 * No runtime import, so a consumer of these loads no schema (hearsay-tools/cezarion#1237).
 */

/** Bounds for one tag and for a project's tag list. Named because three places must agree: the
 *  PATCH body's schema, the registry schema that must never `.catch` away a value this accepts
 *  (`workspaceProjectSchema` in the service), and the settings editor that refuses input early. */
export const PROJECT_TAG_MAX_LENGTH = 32;
export const PROJECT_TAGS_MAX = 20;

/** Bounds shared by the PATCH body and the registry schema, so a stored value can never be
 *  degraded away by the next load's `.catch`. */
export const PROJECT_WEBHOOK_URL_MAX_LENGTH = 2048;
export const PROJECT_WEBHOOK_TOKEN_MAX_LENGTH = 1024;

/**
 * A new project's name: GitHub's repository-name characters (letters, digits, `.`, `-`, `_`, at
 * most 100), starting with a letter or digit as every checkout folder must. It is the folder name
 * and, with `github`, the repository name, so a name GitHub would rewrite is refused — and the
 * schema, the server and the dialog share this ONE rule, so the middleware never passes a name the
 * handler then rejects.
 */
export const PROJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
