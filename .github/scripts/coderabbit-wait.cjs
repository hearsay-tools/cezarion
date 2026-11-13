'use strict';
const { setTimeout: delay } = require('node:timers/promises');
const { readCodeRabbitAdmission } = require('./coderabbit-admission.cjs');
const WAIT_MS = 20 * 60 * 1000, POLL_MS = 30000, MAX_READS = 40, MISSING_MS = 3 * 60 * 1000;

// Only the native gate waits. Queue admission, readiness and reconciliation
// continue to use the immediate reader and their own short deadlines.
async function waitForCodeRabbitAdmission({ now = Date.now, sleep = delay, log = () => {}, ...args }) {
  const start = now(), deadline = start + WAIT_MS, missingDeadline = start + MISSING_MS;
  let admission;
  for (let attempt = 0; attempt < MAX_READS && now() < deadline; attempt++) {
    admission = undefined;
    try {
      admission = await readCodeRabbitAdmission({ ...args, now, sleep, deadline: Math.min(deadline, now() + 60000) });
    } catch (error) {
      if (now() >= deadline) break;
      // A provider can finish between the snapshot's two reads. Discard mixed
      // evidence; the next snapshot must still prove the original expected head.
      if (error.message !== 'Review evidence changed while reading') throw error;
      log('CodeRabbit evidence changed during the read; checking fresh evidence.');
    }
    if (admission && !['missing', 'pending'].includes(admission.providerState)) return admission;
    const observedAt = now();
    if (admission?.providerState === 'missing' && observedAt >= missingDeadline) {
      return { ...admission, reason: 'provider-missing-timeout',
        action: 'Resolve every open review thread. No trusted current-head CodeRabbit check appeared within 3 minutes. Post @coderabbitai full review on the PR; after provider completion, let reconciliation retry the native gate. If needed, dispatch Reconcile CodeRabbit admission with pr_number. Fork PRs require a maintainer native gate rerun.' };
    }
    const remaining = (admission?.providerState === 'missing' ? missingDeadline : deadline) - observedAt;
    if (remaining <= 0) break;
    log('Waiting for the current CodeRabbit execution; the verify aggregate stays blocked until admission.');
    await sleep(Math.min(POLL_MS, remaining));
  }
  return { admitted: false, head: args.head, reason: 'provider-wait-timeout',
    action: 'CodeRabbit did not settle within the 20-minute review wait. Inspect the provider check; reconciliation can retry after it completes.' };
}

module.exports = { waitForCodeRabbitAdmission };
