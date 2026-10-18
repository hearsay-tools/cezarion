/**
 * Page bounds the run-summary routes share with their callers.
 *
 * No runtime import, so a consumer of these loads no schema (hearsay-tools/cezarion#1237).
 */

/** The archived roots `GET /run-summaries/archived` answers per page by default, and at most (#864). */
export const ARCHIVED_RUNS_PAGE_DEFAULT = 50;
export const ARCHIVED_RUNS_PAGE_MAX = 200;
