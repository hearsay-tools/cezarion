#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const directory = path.join(__dirname, 'launch-read-normalization');
const template = YAML.parse(fs.readFileSync(path.join(__dirname, 'launch-read-normalization.yml'), 'utf8'));
template.helpers = Object.assign({}, ...fs.readdirSync(directory).sort().map(file => YAML.parse(fs.readFileSync(path.join(directory, file), 'utf8')).helpers));
const names = new Set(Object.keys(template.helpers));
const localName = name => `normalize-${name}`;
function replaceReferences(value) {
  if (Array.isArray(value)) return value.map(replaceReferences);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const name = key === 'matches' && typeof item === 'string' ? item.replace(/^(lr-|normalize-)/, '') : '';
    return [key, names.has(name) ? localName(name) : replaceReferences(item)];
  }));
}
function collectReferences(value, found = new Set()) {
  if (!value || typeof value !== 'object') return found;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'matches' && typeof item === 'string') found.add(item);
    else collectReferences(item, found);
  }
  return found;
}
function renderRule(suffix, doc) {
  doc.rule = replaceReferences(doc.rule);
  const bindings = template.bindings[suffix];
  const needed = collectReferences(doc.rule);
  doc.utils = {};
  for (const reference of needed) {
    const helper = reference.startsWith('normalize-') ? template.helpers[reference.slice(10)] : undefined;
    const value = helper ? replaceReferences(helper) : bindings[reference] && { matches: localName(bindings[reference]) };
    if (!value) continue; // Global syntax classifiers have no metavariable captures.
    collectReferences(value, needed);
    doc.utils[reference] = value;
  }
  return '# Semantic utils generated from ../launch-read-normalization/; edit that source.\n' +
    YAML.stringify(doc, { lineWidth: 110, aliasDuplicateObjects: false });
}
function familyOf(file) {
  return file.replace('launch-read-outside-resolver-', '').split(/[.-]/)[0];
}
function generate(check = false) {
  let stale = false;
  const rules = path.join(__dirname, 'rules');
  for (const name of fs.readdirSync(rules).filter(name => name.startsWith('launch-read-outside-resolver-') && name.endsWith('.yml'))) {
    const file = path.join(rules, name);
    const original = fs.readFileSync(file, 'utf8');
    const result = renderRule(familyOf(name), YAML.parse(original));
    if (result === original) continue;
    stale = true;
    if (!check) fs.writeFileSync(file, result);
  }
  return !check || !stale;
}
module.exports = { renderRule, generate };
if (require.main === module && !generate(process.argv.includes('--check'))) {
  console.error('Launch-read normalization utilities are stale. Regenerate them.');
  process.exitCode = 1;
}
