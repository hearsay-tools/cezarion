import { registerDelegationIntegrationGroup } from './delegation-integration.testkit.ts';
import { workerCleanups } from '../delegation/worker-cleanup.ts';

registerDelegationIntegrationGroup('reviewed-integration', workerCleanups());
