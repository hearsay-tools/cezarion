/**
 * P5 gate of `migrate-project` (hearsay-tools/cezarion#3089): registration, help, dispatch and the
 * cockpit's migration route. Independent of `REBRAND_SWITCH`, which never enables the command.
 * Not an environment setting. Early recovery of an unfinished journal does not depend on it.
 */
export const PROJECT_MIGRATION_SWITCH = false;
