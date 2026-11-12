/** `PRAGMA user_version` of a database this build created. A higher number means a newer Squawk
 *  wrote it; that is refused rather than read, because a newer schema may store what this one
 *  would silently drop on its next write. */
export const RUN_DATABASE_SCHEMA_VERSION = 11;

/**
 * The oldest `user_version` the READ-ONLY reader can read as it stands (`openReadOnly`). It never
 * migrates, so a project this build has not opened yet is still at the version an earlier build
 * left; while every migration since only adds what readers can do without (indexes), that
 * database stays readable rather than reading as empty. Raise it with any migration that changes
 * a table or column a reader queries.
 */
export const RUN_DATABASE_READABLE_FROM = 1;

/** A format guard for new wait enum values; no table or row rewrite. */
export const MERGE_WAIT_MIGRATION = `
  -- Schema 11 changes no table: PR waits can carry until 'merge_or_blocked' and outcome 'blocked'
  -- (hearsay-tools/cezarion#2712). Older readers cannot parse these enum values and must refuse
  -- the store rather than recover a run without its accepted wait. Upgrade again to recover.
  `;
