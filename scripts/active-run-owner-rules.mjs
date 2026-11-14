import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { isMap, isSeq, parseDocument, visit } from 'yaml';

export const ownerGroups = {
  boundary: {
    owner: 'turn-boundary.ts', factory: 'createBoundaryGroup',
    types: ['BoundaryGroup', 'DoneRequest', 'NextStep', 'DoneClose', 'AckBoundary'],
    getters: ['boundary'],
    bindings: ['boundary', 'doneRequested', 'nextStep', 'doneClose', 'parkAfterAck'],
    fields: ['boundary', 'waitWakeTurn', 'pendingHumanAsk', 'noWaitNudgeReplyTimer', 'noWaitNudgeSawContent', 'noWaitNudgeParked', 'doneAtBoundary', 'doneRequested', 'nextStep', 'completedStepId', 'doneClose', 'parkAfterAck', 'atTurnBoundary', 'idleTimer', 'idleClosed', 'monitoringCapNoted', 'autonomous', 'autonomousNudgePending', 'noWaitNudged', 'incomingRequestRefused', 'sentRequestRefused', 'completionNudged', 'completionNudgeAnswered', 'heldForSubagents', 'session', 'summary', 'label', 'via', 'monitoring', 'humanGate', 'nudgedLastTurn', 'scheduleWakeup'],
  },

  wait: {
    slot: 'waitIdentity', owner: 'wait-registry.ts', factory: 'createWaitGroup',
    types: ['WaitGroup'], getters: ['waitIdentity'],
    bindings: ['waitIdentity', 'ciTurnId'], fields: ['waitIdentity', 'ciTurnId'],
  },
  autosave: {
    owner: 'worktree-autosave.ts', factory: 'createAutosaveGroup',
    types: ['AutosaveGroup'], getters: ['autosave', 'autosaveTimer'],
    fields: ['autosave', 'autosaveTimer'],
  },
  input: {
    slot: 'inputState', owner: 'input-delivery.ts', factory: 'createInputGroup',
    types: ['InputGroup', 'InputFlight', 'ReadonlySetView'],
    getters: ['inputState'],
    bindings: ['inputState', 'agentInputFlight', 'inputDelivery', 'unreadInputIds', 'consumedBeforeAck', 'bundledInputIds', 'retiredInFlight', 'unreadRetried', 'inputIds'],
    fields: ['inputState', 'agentInputError', 'agentInputFlight', 'inputDelivery', 'unreadInputIds', 'consumedBeforeAck', 'bundledInputIds', 'retiredInFlight', 'unreadInputTimer', 'unreadRetried', 'heldHumanInputTimer', 'heldHumanInputSince', 'heldHumanInputExpired', 'openingAnswerAskSeq', 'openingAgentInputId', 'writingInput', 'session', 'inputIds', 'settled', 'wakeReserved', 'admittedWake', 'mode', 'consumption', 'via', 'length', 'size'],
  },
  session: {
    slot: 'liveSession', owner: 'live-session-state.ts', factory: 'createSessionGroup',
    types: ['SessionGroup', 'ReadonlySetView'],
    getters: ['liveSession'],
    bindings: ['liveSession', 'delegationSettings', 'pendingPermissions', 'accountBinding', 'claudeLayout', 'allowedTools', 'bashAllowlist'],
    fields: ['liveSession', 'delegationSettings', 'revokeDelegation', 'revokeCiTools', 'ciGeneration', 'cancelled', 'finishRequested', 'interrupt', 'cwd', 'session', 'pendingPermissions', 'agentSessionError', 'currentStepId', 'sessionEverOpened', 'releaseRepoRoot', 'runner', 'model', 'modelIdentity', 'effort', 'agentProfile', 'accountBinding', 'systemPrompt', 'allowedTools', 'bashAllowlist', 'provider', 'profileId', 'homePath', 'claudeLayout', 'kind', 'statePath', 'length', 'size'],
  },
  usage: {
    owner: 'usage-accounting.ts', factory: 'createUsageGroup',
    types: ['UsageGroup', 'UsageInvocation', 'ReadonlyMapView', 'ReadonlySetView'],
    getters: ['cumulativeSessionCost', 'usageInvocation', 'startedTurns', 'recordedTurns'],
    fields: ['usage', 'cumulativeSessionCost', 'usageInvocation', 'observed', 'epoch', 'stepId', 'startedTurns', 'recordedTurns', 'size'],
  },
  skills: {
    owner: 'run-skills.ts', factory: 'createSkillsGroup',
    types: ['SkillsGroup', 'SkillView', 'SkillTeamView'],
    getters: ['catalog', 'liveSkillProvisioning'],
    fields: ['skills', 'catalog', 'liveSkillProvisioning', 'team', 'name', 'description', 'interactive', 'body', 'path', 'source', 'repo', 'ref', 'dir', 'commit', 'length'],
  },
  children: {
    owner: 'subagent-waits.ts', factory: 'createChildrenGroup',
    types: ['ChildrenGroup', 'ReadonlyMapView'],
    getters: ['backgroundChildren'],
    fields: ['children', 'backgroundChildren', 'session', 'status', 'size'],
  },
};
const template = new URL('../.ai/ast-grep/active-run-owner-template.yml', import.meta.url);
export const ruleFile = (group) => new URL(`../.ai/ast-grep/rules/active-run-${group}-write-outside-owner.yml`, import.meta.url);

/** Generate syntax rules from one reviewed template; group metadata never supplies code. */
export function renderOwnerRule(group) {
  const metadata = ownerGroups[group];
  if (!metadata) throw new Error(`Unknown ActiveRun owner group: ${group}`);
  const substitutions = {
    __GROUP__: group, __SLOT__: metadata.slot ?? group, __OWNER__: metadata.owner, __FACTORY__: metadata.factory, __TYPES__: metadata.types.join('|'),
    __GETTERS__: metadata.getters.join('|'), __BINDINGS__: (metadata.bindings ?? metadata.getters).join('|'), __FIELDS__: metadata.fields.join('|'),
  };
  const doc = parseDocument(readFileSync(template, 'utf8'));
  if (doc.errors.length) throw doc.errors[0];
  visit(doc, { Scalar(_key, node) {
    if (typeof node.value !== 'string') return;
    for (const [key, value] of Object.entries(substitutions)) node.value = node.value.replaceAll(key, value);
  } });
  // Short predicates stay on one line. Keep structural relations expanded for review.
  visit(doc, (_key, node) => {
    if ((isMap(node) || isSeq(node)) && JSON.stringify(node.toJSON()).length <= 110) node.flow = true;
  });
  return '# Generated by scripts/active-run-owner-rules.mjs --write; edit the template and group metadata.\n' + doc.toString({ lineWidth: 120 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const group of Object.keys(ownerGroups)) {
    const rendered = renderOwnerRule(group);
    if (process.argv.includes('--write')) writeFileSync(ruleFile(group), rendered);
    else if (readFileSync(ruleFile(group), 'utf8') !== rendered) {
      throw new Error(`ActiveRun ${group} rule drifted; run node scripts/active-run-owner-rules.mjs --write`);
    }
  }
}
