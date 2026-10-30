'use strict';
// The optional equivalent-mutant list (spec Decisions 2), read by the PR job and the
// whole-file command (hearsay-tools/cezarion#2282). Matching uses full source text.
const fs = require('node:fs');

const EQUIVALENT_FILE = '.github/mutants/equivalent.json';
const FIELDS = ['file', 'function', 'mutator', 'original', 'replacement', 'reason'];
const normalize = text => text.replace(/\s+/g, ' ').trim();

/** Read the optional list without making a broken list stop the advisory report. */
function readEquivalent(file = EQUIVALENT_FILE, io = fs) {
  try {
    const entries = JSON.parse(io.readFileSync(file, 'utf8'));
    if (!Array.isArray(entries)) throw new Error('expected an array');
    if (entries.some(entry => !entry || FIELDS.some(key => typeof entry[key] !== 'string' || !entry[key].trim()))) {
      throw new Error('each entry needs non-empty file, function, mutator, original, replacement and reason strings');
    }
    return { entries, warning: '' };
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: [], warning: '' };
    return { entries: [], warning: `Could not read equivalent mutants: ${String(error.message).replace(/\s+/g, ' ').slice(0, 240)}` };
  }
}

function matchesEntry(entry, mutant) {
  return entry.file === mutant.file && entry.mutator === mutant.mutator
    && normalize(entry.original) === normalize(mutant.original)
    && normalize(entry.replacement) === normalize(mutant.replacement)
    && (mutant.function === undefined || entry.function === mutant.function);
}

const findEquivalent = (entries, mutant) => entries.find(entry => matchesEntry(entry, mutant));

module.exports = { EQUIVALENT_FILE, readEquivalent, matchesEntry, findEquivalent };
