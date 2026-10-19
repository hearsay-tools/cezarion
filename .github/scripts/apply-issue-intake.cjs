'use strict';

const ACTIONS = new Set(['duplicate', 'label', 'skip']);

function assertKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} has unknown key "${key}".`);
}
function assertRequired(value, required, label) {
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${label} ${key} is required.`);
}

function validateIntake(intake) {
  if (!intake || typeof intake !== 'object' || Array.isArray(intake)) throw new Error('Intake must be an object.');
  assertKeys(intake, new Set(['action', 'duplicate_of', 'comment', 'labels']), 'Intake');
  assertRequired(intake, ['action', 'duplicate_of', 'comment', 'labels'], 'Intake');
  if (!ACTIONS.has(intake.action)) throw new Error('action is invalid.');
  if (intake.duplicate_of !== null && (!Number.isInteger(intake.duplicate_of) || intake.duplicate_of <= 0)) {
    throw new Error('duplicate_of must be a positive integer or null.');
  }
  if (intake.comment !== null && (typeof intake.comment !== 'string' || intake.comment.trim().length === 0)) {
    throw new Error('comment must be a non-empty string or null.');
  }
  if (!Array.isArray(intake.labels) || intake.labels.some((label) => typeof label !== 'string' || label.length === 0)) {
    throw new Error('labels must be an array of non-empty strings.');
  }
}

function loadIntake(input) {
  let intake;
  try {
    intake = typeof input === 'string' ? JSON.parse(input) : input;
  } catch (error) {
    throw new Error(`Invalid intake JSON: ${error.message}`);
  }
  validateIntake(intake);
  return intake;
}

function labelMutations(intake, issueNumber, knownLabels) {
  const labels = intake.labels.filter((label) => knownLabels.has(label) && label !== 'friction' && !label.startsWith('friction-'));
  if (labels.length === 0) return [];
  return [['issue', 'edit', String(issueNumber), '--add-label', labels.join(',')]];
}

// candidateNumbers, when given, is the duplicate candidate set rebuilt by
// issue-intake-candidates.cjs. A duplicate pick outside it (the issue itself,
// a split-out parent, a closed issue) labels the issue and leaves it open.
function planIntakeMutations({ intake, issueNumber, knownLabels, candidateNumbers, warn = () => {} }) {
  validateIntake(intake);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error('issueNumber must be a positive integer.');
  if (!(knownLabels instanceof Set)) throw new Error('knownLabels must be a Set.');
  if (candidateNumbers !== undefined && !(candidateNumbers instanceof Set)) throw new Error('candidateNumbers must be a Set.');

  if (intake.action === 'skip') return [];

  if (intake.action === 'duplicate' && candidateNumbers && !candidateNumbers.has(intake.duplicate_of)) {
    warn(`#${intake.duplicate_of} is not a duplicate candidate for #${issueNumber}; labeling instead of closing.`);
    return labelMutations(intake, issueNumber, knownLabels);
  }

  if (intake.action === 'duplicate') {
    if (intake.duplicate_of === null) throw new Error('duplicate_of is required for a duplicate action.');
    if (intake.duplicate_of === issueNumber) throw new Error('An issue cannot be a duplicate of itself.');
    if (typeof intake.comment !== 'string') throw new Error('A duplicate close requires a comment.');
    const mutations = [
      ['issue', 'close', String(issueNumber), '--reason', 'duplicate', '--duplicate-of', String(intake.duplicate_of), '--comment', intake.comment],
    ];
    if (knownLabels.has('duplicate')) {
      mutations.push(['issue', 'edit', String(issueNumber), '--add-label', 'duplicate']);
    }
    return mutations;
  }

  return labelMutations(intake, issueNumber, knownLabels);
}

module.exports = { loadIntake, planIntakeMutations, validateIntake };
