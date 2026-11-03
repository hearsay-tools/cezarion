'use strict';
// Called only under the reconciler's PR lock. Claims and command receipts never
// grant admission. Use the App client solely for the one comment POST.
const { reader, positive } = require('./queue-ci-proof.cjs');
const { claims, reserve, record, inspect } = require('./coderabbit-recovery-claim.cjs');
const command = (number, head, id) => `@coderabbitai full review\n\n<!-- cezar-coderabbit-recovery:v1:${number}:${head}:${id} -->`;
function senderAvailable(sender, login) {
  return Boolean(sender?.github && typeof login === 'string' && /^[a-z0-9][a-z0-9-]*\[bot\]$/.test(login)
    && `${sender.slug}[bot]` === login);
}
function receipt(comment, body, login) {
  return positive(comment?.id) && comment.body === body && comment.user?.login === login && comment.user.type === 'Bot';
}
async function inspectComments(read, number, body, login) {
  const matches = [];
  for (let page = 1; page <= 2; page++) {
    const rows = await read('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { issue_number: number, page, per_page: 100 });
    if (!Array.isArray(rows) || rows.length > 100) throw inspect('Incomplete command receipt inventory');
    matches.push(...rows.filter(c => receipt(c, body, login)));
    if (matches.length > 1) throw inspect('Duplicate recovery command receipts');
    if (rows.length < 100) return matches[0] ?? null;
  }
  throw inspect('Command receipt pagination limit');
}
async function existingClaim(read, found, number, head, login, log) {
  for (const check of found) {
    let comment;
    try { comment = await inspectComments(read, number, command(number, head, check.id), login); }
    catch { log(`PR ${number}: recovery claim ${check.id} exists; command receipt is unavailable. Inspect PR comments and provider; never resend automatically.`); continue; }
    log(`PR ${number}: recovery claim ${check.id} exists; ${comment ? `command comment ${comment.id} is visible; wait for provider completion` : 'command may be unsent or ambiguous; inspect before manual recovery'}. No automatic resend.`);
  }
  return 'recovery-already-claimed';
}
async function recoverNoFiles({ github, owner, repo, pr, evidence, admission, sender, releaseAppBotLogin,
  runId, now, deadline, log }) {
  if (!evidence.recoveryEligible || evidence.exception) return 'recovery-not-applicable';
  const read = reader(github, owner, repo, deadline, now), fullName = `${owner}/${repo}`;
  const found = await claims(read, pr.number, pr.head.sha);
  if (found.length) return existingClaim(read, found, pr.number, pr.head.sha, releaseAppBotLogin, log);
  if (!senderAvailable(sender, releaseAppBotLogin)) {
    log(`PR ${pr.number}: automatic full-review sender unavailable or identity mismatch. Inspect the trusted CodeRabbit check and request @coderabbitai full review manually. Admission remains blocked.`);
    return 'recovery-sender-unavailable';
  }
  const current = await admission();
  if (!current.recoveryEligible || current.checkId !== evidence.checkId) return 'recovery-evidence-changed';
  const inspectionDue = new Date(now() + 600000).toISOString();
  const check = await reserve({ read, fullName, number: pr.number, head: pr.head.sha, runId, inspectionDue });
  // Crash-before-send and every later failure leave the reservation in place.
  let final;
  try { final = await admission(); }
  catch {
    await record(read, check, 'aborted', 'Live provider/head evidence became unavailable before send. No command sent. Inspect before manual recovery.', log);
    return 'recovery-evidence-changed';
  }
  if (!final.recoveryEligible || final.checkId !== evidence.checkId) {
    await record(read, check, 'aborted', 'Provider/head changed before send. No command sent. Reservation retained; no automatic resend.', log);
    return 'recovery-evidence-changed';
  }
  const body = command(pr.number, pr.head.sha, check.id);
  const send = reader(sender.github, owner, repo, deadline, now);
  let comment;
  try {
    comment = await send('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { issue_number: pr.number, body });
    if (!receipt(comment, body, releaseAppBotLogin)) comment = null;
  } catch { /* A rejected or timed-out POST can still have been accepted. */ }
  if (!comment) {
    try { comment = await inspectComments(read, pr.number, body, releaseAppBotLogin); }
    catch { /* Inspection failure leaves the durable reservation authoritative. */ }
  }
  const state = comment ? 'requested' : 'ambiguous';
  const summary = comment
    ? `Full-review command comment ${comment.id} accepted for PR ${pr.number}, head ${pr.head.sha}. Wait for a new trusted provider execution; this is not admission. No automatic resend.`
    : 'Command acceptance is uncertain. Inspect PR comments and provider; no automatic resend. This claim never grants admission.';
  await record(read, check, state, `${summary} Inspection due: ${inspectionDue}; maintainer inspection only, no automatic timer.`, log);
  log(`PR ${pr.number}: recovery ${state}; claim ${check.id}. ${summary}`);
  return `recovery-${state}`;
}
module.exports = { recoverNoFiles, command, senderAvailable };
