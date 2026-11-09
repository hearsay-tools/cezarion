import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testFilePattern } from './vitest-coverage.mjs';

const fields = new Set(['runner', 'tests', 'imports', 'projects', 'cwd']);

function strings(value, field, required = false) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || (required && !value.length) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`Collection ${field} must be ${required ? 'a nonempty array' : 'an array'} of nonempty strings.`);
  }
  return value;
}

function localFile(file, cwd) {
  const path = realpathSync(resolve(cwd, file));
  if (!statSync(path).isFile()) throw new Error(`Expected a collection file: ${file}`);
  return path;
}

function importPath(specifier, cwd) {
  if (specifier.startsWith('file:')) return localFile(fileURLToPath(specifier), cwd);
  if (isAbsolute(specifier) || specifier.startsWith('.') || existsSync(resolve(cwd, specifier))) {
    return localFile(specifier, cwd);
  }
  return createRequire(join(cwd, 'package.json')).resolve(specifier);
}

function collection(value, commandCwd) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Each collection must be a JSON object.');
  const unknown = Object.keys(value).filter(field => !fields.has(field));
  if (unknown.length) throw new Error(`Unknown collection fields: ${unknown.join(', ')}.`);
  if (!['node', 'vitest'].includes(value.runner)) throw new Error('Collection runner must be node or vitest.');
  if (value.cwd !== undefined && (typeof value.cwd !== 'string' || !value.cwd.trim())) {
    throw new Error('Collection cwd must be a nonempty string.');
  }
  const cwd = realpathSync(resolve(commandCwd, value.cwd ?? '.'));
  if (!statSync(cwd).isDirectory()) throw new Error(`Collection cwd must be a directory: ${cwd}`);
  const tests = strings(value.tests, 'tests', true).map(file => localFile(file, cwd));
  if (tests.some(file => !testFilePattern.test(file))) throw new Error('Collection tests must name test files (*.test, *.spec or *.e2e).');
  const imports = strings(value.imports, 'imports');
  const projects = strings(value.projects, 'projects');
  if (value.imports !== undefined && value.runner !== 'node') throw new Error('Collection imports require Node.');
  if (value.projects !== undefined && value.runner !== 'vitest') throw new Error('Collection projects require Vitest.');
  return { runner: value.runner, cwd, tests, imports: imports.map(file => importPath(file, cwd)), projects };
}

/** A test belongs to exactly one collection, including aliases through symlinks. */
export function assertUniqueTests(collections) {
  const assigned = new Set();
  for (const group of collections) {
    for (const test of group.tests) {
      const file = realpathSync(test);
      if (assigned.has(file)) throw new Error(`Duplicate test assignment: ${file}`);
      assigned.add(file);
    }
  }
}

/** Each argument is one inline object or a path to a manifest containing one object. */
export function parseCollections(arguments_, cwd) {
  const collections = arguments_.map(argument => {
    const text = argument.trimStart().startsWith('{') ? argument : readFileSync(resolve(cwd, argument), 'utf8');
    return collection(JSON.parse(text), cwd);
  });
  assertUniqueTests(collections);
  return collections;
}
