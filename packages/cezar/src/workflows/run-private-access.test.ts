import { testHome } from '../home/test-home.testkit.ts';
import { parse } from '@babel/parser';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { API } from 'typescript/unstable/sync';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { acquireInertCiResources } from '../ci-wait/inert-ci-resources.testkit.ts';
import { createRunner } from '../core/runner-factory.ts';

function privateMembers() {
  const source = readFileSync(new URL('./run.ts', import.meta.url), 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const declaration = ast.program.body.find(node => node.type === 'ExportNamedDeclaration'
    && node.declaration?.type === 'ClassDeclaration' && node.declaration.id?.name === 'RunManager');
  if (declaration?.type !== 'ExportNamedDeclaration' || declaration.declaration?.type !== 'ClassDeclaration') throw new Error('RunManager class missing');
  const members = declaration.declaration.body.body;
  const names: string[] = [];
  for (const member of members) {
    if ('key' in member && member.key.type === 'PrivateName') names.push(member.key.id.name);
    else if ('accessibility' in member && member.accessibility === 'private' && 'key' in member && member.key.type === 'Identifier') names.push(member.key.name);
    if (member.type === 'ClassMethod' && member.kind === 'constructor') {
      for (const param of member.params) {
        if (param.type === 'TSParameterProperty' && param.accessibility === 'private' && param.parameter.type === 'Identifier') names.push(param.parameter.name);
      }
    }
  }
  expect(names.length).toBeGreaterThan(0);
  return { names, members };
}

it('hides every AST-derived private member at runtime', () => {
  const { names, members } = privateMembers();
  const root = mkdtempSync(join(tmpdir(), 'cez-private-'));
  const store = RunStore.open(join(root, '.ai/cezar'));
  const manager = new RunManager(store, root, { acquireCiResources: acquireInertCiResources, createRunner, home: testHome() });
  try {
    // Construction is the product signal: every field has been initialized.
    for (const name of names) expect((manager as unknown as Record<string, unknown>)[name], name).toBeUndefined();
    for (const name of names) {
      expect(Object.getOwnPropertyNames(manager)).not.toContain(name);
      expect(Object.getOwnPropertyNames(RunManager.prototype)).not.toContain(name);
    }
    expect(members.some(member => 'accessibility' in member && member.accessibility === 'private')).toBe(false);
  } finally {
    manager.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});


it('rejects every private access through the pinned compiler API', () => {
  const { names } = privateMembers();
  const root = mkdtempSync(join(tmpdir(), 'cez-private-compile-'));
  const api = new API();
  try {
    const fixture = join(root, 'private-access.mts');
    const config = join(root, 'tsconfig.json');
    const managerSource = fileURLToPath(new URL('./run.ts', import.meta.url));
    const accesses = names.flatMap(name => [
      `void manager.#${name};`,
      '// @ts-expect-error The former named member is inaccessible.',
      `void manager.${name};`,
      '// @ts-expect-error The former bracket member is inaccessible.',
      `void manager['${name}'];`,
    ]);
    writeFileSync(fixture, `import type { RunManager } from ${JSON.stringify(managerSource)};\ndeclare const manager: RunManager;\n${accesses.join('\n')}\n`);
    writeFileSync(config, JSON.stringify({
      extends: fileURLToPath(new URL('../../tsconfig.test.json', import.meta.url)),
      compilerOptions: { rootDir: '/', noEmit: true, rewriteRelativeImportExtensions: false, typeRoots: [fileURLToPath(new URL('../../node_modules/@types', import.meta.url))] },
      files: [fixture], include: [], exclude: [],
    }));
    using snapshot = api.updateSnapshot({ openProjects: [config] });
    const project = snapshot.getProject(config);
    if (!project) throw new Error('Compile proof project missing');
    const program = project.program;
    const diagnostics = [
      ...program.getConfigFileParsingDiagnostics(), ...program.getProgramDiagnostics(),
      ...program.getGlobalDiagnostics(), ...program.getSyntacticDiagnostics(),
      ...program.getBindDiagnostics(), ...program.getSemanticDiagnostics(),
    ];
    expect(diagnostics.map(diagnostic => diagnostic.code), JSON.stringify(diagnostics)).toEqual(names.map(() => 18013));
    for (const [index, name] of names.entries()) {
      expect(diagnostics[index]?.text).toContain(`#${name}`);
    }
  } finally {
    api.close();
    rmSync(root, { recursive: true, force: true });
  }
});
