import { existsSync } from 'node:fs';
import { previewStopRequestSchema, previewServeRequestSchema, type PreviewStopRequest, type PreviewStopResult, type PreviewServeRequest, type PreviewServeResult } from '@open-mercato/cezar-contract/preview';
import type { RunStore } from '../runs/store.ts';
import { previewToolEnabled } from '../ci-wait/tools.ts';
import { previewStopResult, previewResult, validateRegistration, type PreviewHostLike } from './registration.ts';

export async function stopPreviewServer(store: RunStore, preview: PreviewHostLike | undefined, cezarPort: (() => number | undefined) | undefined, disposed: () => boolean, runId: string, request: PreviewStopRequest, signal?: AbortSignal): Promise<PreviewStopResult> {
    const parsed = previewStopRequestSchema.parse(request);
    if (!previewToolEnabled()) return previewStopResult('preview_disabled');
    if (!preview) return previewStopResult('headless');
    if (disposed() || signal?.aborted) return previewStopResult('unavailable');
    const run = store.getRun(runId);
    if (!run?.worktreePath || !existsSync(run.worktreePath)) return previewStopResult('worktree_missing');
    const owner = preview.portOwner(parsed.port);
    if (owner && owner.runId !== runId) return previewStopResult('port_held');
    if (!run.previewServers?.some(server => server.port === parsed.port)) return previewStopResult('not_registered');
    return preview.stopPreview(runId, parsed, signal);
  }

  /**
   * #781: record a dev server the agent registered. One probe at registration becomes
   * `answeredAtRegistration`; the run is re-validated after it, since the probe awaits.
   */
export async function registerPreviewServer(store: RunStore, preview: PreviewHostLike | undefined, cezarPort: (() => number | undefined) | undefined, disposed: () => boolean, runId: string, request: PreviewServeRequest, signal?: AbortSignal): Promise<PreviewServeResult> {
    const parsed = previewServeRequestSchema.parse(request);
    const validate = () => {
      const run = store.getRun(runId);
      const owner = preview?.portOwner(parsed.port);
      const result = validateRegistration({
        request: parsed,
        worktreePath: run?.worktreePath && existsSync(run.worktreePath) ? run.worktreePath : undefined,
        cezarPort: cezarPort?.(),
        existing: run?.previewServers ?? [],
        owner,
        runId,
        enabled: previewToolEnabled(),
        headless: !preview,
      });
      const withoutWorktree = !!run && !run.worktreePath;
      return { ...result, answer: () => previewResult(result.code, { ...parsed, ownerTitle: owner?.title, withoutWorktree }) };
    };
    const first = validate();
    if (!first.server || !preview) return first.answer();
    // A server process supplies `cezarPort`, but recovered runs can call before the cockpit binds:
    // until it knows its port, `cezar_port` cannot be checked, so the tool asks for a retry instead.
    if (cezarPort && cezarPort() === undefined) return previewResult('unavailable', parsed);
    const answered = await preview.probe(parsed.port).catch(() => false);
    // A session revoked during the probe (cancel, stop) must leave no card behind.
    signal?.throwIfAborted();
    const checked = validate();
    if (!checked.server) return checked.answer();
    const server = { ...checked.server, answeredAtRegistration: answered };
    const existing = store.getRun(runId)?.previewServers ?? [];
    const previous = existing.find(entry => entry.port === server.port);
    const changed = !!previous && (previous.command !== server.command || previous.cwd !== server.cwd || previous.path !== server.path);
    const previewServers = checked.code === 'replaced'
      ? existing.map(entry => entry.port === server.port ? server : entry)
      : [...existing, server];
    store.updateRun(runId, { previewServers });
    store.appendEvent(runId, { type: 'preview.server-registered', server });
    // A copy cezar runs from the old command must not keep answering for the new registration.
    if (changed) await preview.replaced(runId, server.port).catch(() => {});
    return checked.answer();
  }

