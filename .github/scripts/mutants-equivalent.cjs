'use strict';
// The optional equivalent-mutant list (spec Decisions 2), read by the PR job and the
// whole-file command (hearsay-tools/cezarion#2282). Matching uses full source text.
const fs = require('node:fs');

const EQUIVALENT_FILE = '.github/mutants/equivalent.json';
const FIELDS = ['file', 'function', 'mutator', 'original', 'replacement', 'reason'];
/** Read the optional list without making a broken list stop the advisory report. */
function readEquivalent(file = EQUIVALENT_FILE, io = fs) {
  try {
    const entries = JSON.parse(io.readFileSync(file, 'utf8'));
    if (!Array.isArray(entries)) throw new Error('expected an array');
    if (entries.some(entry => !entry || FIELDS.some(key => typeof entry[key] !== 'string' || !entry[key].trim()))) {
      throw new Error('each entry needs non-empty file, function, mutator, original, replacement and reason strings');
    }
    if (entries.some(entry => entry.site !== undefined && (typeof entry.site !== 'string' || !entry.site.trim()))) {
      throw new Error('site must be a non-empty source prefix string');
    }
    return { entries, warning: '' };
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: [], warning: '' };
    return { entries: [], warning: `Could not read equivalent mutants: ${String(error.message).replace(/\s+/g, ' ').slice(0, 240)}` };
  }
}

/** Exact line prefix before the mutant, with indentation removed and trailing spaces kept. */
function sourceSite(source, { start }) {
  return source.split('\n')[start.line - 1].slice(0, start.column - 1).trimStart();
}

function matchesEntry(entry, mutant) {
  return entry.file === mutant.file && entry.mutator === mutant.mutator
    && (entry.site === undefined || entry.site === mutant.site)
    && entry.original === mutant.original
    && entry.replacement === mutant.replacement
    && (typeof mutant.function === 'string' && entry.function === mutant.function);
}

const findEquivalent = (entries, mutant) => entries.find(entry => matchesEntry(entry, mutant));

module.exports = { EQUIVALENT_FILE, readEquivalent, matchesEntry, findEquivalent, sourceSite };
