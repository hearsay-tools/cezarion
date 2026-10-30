'use strict';
// The optional equivalent-mutant list (spec Decisions 2), read by the PR job and the
// whole-file command (hearsay-tools/cezarion#2282). Matching uses full source text.
const fs = require('node:fs');

const EQUIVALENT_FILE = '.github/mutants/equivalent.json';
const FIELDS = ['file', 'function', 'mutator', 'original', 'replacement', 'reason'];
/** Keep literal contents exact while ignoring formatting between source tokens. */
function normalizeSource(text) {
  let result = '';
  let quote = '';
  let escaped = false;
  let space = false;
  for (const char of text) {
    if (quote) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
    } else if (/\s/.test(char)) {
      space = true;
    } else {
      if (space && result) result += ' ';
      space = false;
      result += char;
      if (char === "'" || char === '"' || char === '`') quote = char;
    }
  }
  return result;
}

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
    && normalizeSource(entry.original) === normalizeSource(mutant.original)
    && normalizeSource(entry.replacement) === normalizeSource(mutant.replacement)
    && (mutant.function === undefined || entry.function === mutant.function);
}

const findEquivalent = (entries, mutant) => entries.find(entry => matchesEntry(entry, mutant));

/** Only a unique match within the full file is safe when function names are absent. */
function equivalentMutants(entries, mutants) {
  const hidden = new Set();
  for (const entry of entries) {
    const matches = mutants.filter(mutant => matchesEntry(entry, mutant));
    if (matches.length === 1) hidden.add(matches[0]);
  }
  return hidden;
}

module.exports = { EQUIVALENT_FILE, readEquivalent, matchesEntry, findEquivalent, normalizeSource, equivalentMutants };
