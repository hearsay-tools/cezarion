import { acquirePooledCiResources, type CiResources, type CiSupervisorLike } from './resource-pool.ts';

const NO_SUPERVISOR = 'This test fixture has no CI supervisor (ci-wait/inert-ci-resources.testkit.ts). '
  + 'A test that registers or watches a PR wait passes the real `acquireCiResources` from ci-wait/resources.ts to its RunManager.';

/** A supervisor for managers whose tests never wait on a PR. It throws at once, so a test that
 *  needs real CI fails with this fixture's name instead of passing on another path. */
const inertSupervisor: CiSupervisorLike = {
  resolve: () => { throw new Error(NO_SUPERVISOR); },
  watch: () => { throw new Error(NO_SUPERVISOR); },
  close() {},
};

/** The default CI resources of the engine testkits: the real shared pool and tool controller,
 *  without `ci-wait/supervisor.ts`. Managers on one semaphore share one pool, as in production. */
export function acquireInertCiResources(workspace: object): CiResources {
  return acquirePooledCiResources(workspace, createInertSupervisor);
}

/** One function for every acquire: the pool tells supervisor factories apart by identity. */
function createInertSupervisor(): CiSupervisorLike {
  return inertSupervisor;
}
