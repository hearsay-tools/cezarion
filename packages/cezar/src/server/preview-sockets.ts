import type { PreviewHost } from '../preview/host.ts';
import { createPreviewCdpSocket } from './preview-cdp-socket.ts';
import { createPreviewSocket, type PreviewSocketDeps } from './preview-socket.ts';
import type { UpgradeRoute } from './upgrade-router.ts';

/**
 * The preview's two upgrade routes, built and closed together: the owner's pane socket (#781) and the
 * agent's CDP proxy (hearsay-tools/cezarion#784), the only way to the task's Chromium.
 */
export function createPreviewSockets(deps: Omit<PreviewSocketDeps, 'host'> & { host?: PreviewHost | undefined; cockpitOrigin: () => string | undefined }): { routes: UpgradeRoute[]; close(): void } {
  const pane = createPreviewSocket(deps);
  const agent = createPreviewCdpSocket({ host: deps.host, cockpitOrigin: deps.cockpitOrigin });
  return {
    routes: [pane.route, agent.route],
    close() {
      pane.close();
      agent.close();
    },
  };
}
