#!/usr/bin/env node
// Regenerate with: node .ai/ast-grep/generate-launch-read-matrix.cjs
// --check verifies the committed matrix without writing it.
const { parse } = require('@babel/parser');

const prefix = '/* launch-matrix:';
const generated = { fields: { valid: [], invalid: [] }, capture: { valid: [], invalid: [] }, selectors: { valid: [], invalid: [] } };
const dimensions = {};
const documentedLimits = [];
const structuralLimit = 'The launch-read-outside-resolver rule family does not infer launch-source types through nested structural member paths with two or more property accesses before the launch field or copy operation (class fix: hearsay-tools/cezarion#2744).';
function addMember(family, valid, axes, code, accesses) {
  const explicitLeafType = axes.at(-2) === 'leaf' && ['cast', 'satisfies', 'angle', 'recursive'].includes(axes.at(-3));
  if (!valid && accesses >= 2 && !explicitLeafType) documentedLimits.push({ family, axes, code, reason: structuralLimit });
  else add(family, valid, axes, code);
}
function add(family, valid, axes, code) {
  const id = axes.join('/');
  generated[family][valid ? 'valid' : 'invalid'].push(`${prefix} ${id} */ ${code}`);
}
const wrappers = {
  plain: (value) => value,
  paren: (value) => `(${value})`,
  nonnull: (value) => `${value}!`,
  cast: (value, type) => `(${value} as ${type})`,
  satisfies: (value, type) => `(${value} satisfies ${type})`,
  deep: (value) => `(((${value})))`,
  angle: (value, type) => `(<${type}>${value})`,
  recursive: (value, type) => `((${value} as ${type})! satisfies ${type})`,
};
const functions = {
  declaration: (type, body) => `function choose(source: ${type}) { ${body} }`,
  expression: (type, body) => `const choose = function(source: ${type}) { ${body} };`,
  arrow: (type, body) => `const choose = (source: ${type}) => { ${body} };`,
  object_method: (type, body) => `const holder = { choose(source: ${type}) { ${body} } };`,
  class_method: (type, body) => `class Holder { choose(source: ${type}) { ${body} } }`,
  object_getter: (type, body) => `function outer(source: ${type}) { const holder = { get selected() { ${body} return undefined; } }; }`,
  object_setter: (type, body) => `function outer(source: ${type}) { const holder = { set selected(value: unknown) { ${body} } }; }`,
  class_getter: (type, body) => `function outer(source: ${type}) { class Holder { get selected() { ${body} return undefined; } } }`,
  class_setter: (type, body) => `function outer(source: ${type}) { class Holder { set selected(value: unknown) { ${body} } } }`,
};
const fields = {
  StartRunInput: 'task model effort runner agentProfile images systemPrompt worktree autonomous archiveWhenDone autoMergePr notify stackedImages persistedImages persistedAttachments automation automationTrigger',
  WorkflowDef: 'steps name',
  WorkflowStepDef: 'model effort runner agentProfile prompt skill allowedTools bashAllowlist',
  WorkerStepIdentity: 'grants account model effort',
  CezConfig: 'baseBranch worktreeSetup defaultRunner systemPrompt',
  PendingContinuation: 'prompt images',
  PendingJob: 'input workflow',
  RunRecord: 'model effort runner systemPrompt taskImages queuedMessages continuationMessage workflowDef task agentProfile',
  StepState: 'sessionTransport profileId',
  Execution: 'workflow input',
  LaunchConfig: 'baseBranch defaultRunner systemPrompt worktreeSetup',
  LaunchSource: 'model effort runner images task systemPrompt',
};
const sourceTypes = [...Object.keys(fields), 'ExecutionLaunch'];
const readForms = {
  member: (receiver, field) => `void ${receiver}.${field};`,
  bracket: (receiver, field) => `void ${receiver}['${field}'];`,
  destructure: (receiver, field) => `const { ${field}: selected } = ${receiver}; void selected;`,
  assignment: (receiver, field) => `let selected; ({ ${field}: selected } = ${receiver}); void selected;`,
};
const typeWrappers = {
  plain: type => type,
  paren: type => `(${type})`,
  undefined: type => `${type} | undefined`,
  null: type => `${type} | null`,
  readonly: type => `Readonly<${type}>`,
};
const representativeFields = { StartRunInput: 'model', WorkflowDef: 'steps', WorkflowStepDef: 'allowedTools', CezConfig: 'baseBranch', LaunchConfig: 'defaultRunner' };
function fieldCartesian() {
  for (const [type, field] of Object.entries(representativeFields)) {
    for (const [form, read] of Object.entries(readForms)) for (const [wrapper, wrap] of Object.entries(wrappers)) {
      for (const [kind, enclose] of Object.entries(functions)) {
        const axes = [type, field, form, wrapper, kind];
        add('fields', false, [...axes, 'owned'], enclose(type, read(wrap('source', type), field)));
        add('fields', true, [...axes, 'unrelated'], enclose('Display', read(wrap('source', 'Display'), field)));
        add('fields', true, [...axes, 'value_shadow'], `function boundary(source: ${type}) { ${enclose('Display', read(wrap('source', 'Display'), field))} }`);
        add('fields', true, [...axes, 'block_shadow'], enclose(type, `{ const source: Display = display(); ${read(wrap('source', 'Display'), field)} }`));
        add('fields', true, [...axes, 'type_shadow'], `import type { ${type} as Raw } from './types.ts'; function boundary() { type Raw = Display; ${enclose('Raw', read(wrap('source', 'Raw'), field))} }`);
      }
    }
  }
}
function fieldCompleteness() {
  for (const [type, names] of Object.entries(fields)) for (const field of names.split(' ')) {
    for (const [form, read] of Object.entries(readForms)) for (const [wrapper, wrap] of Object.entries(wrappers)) {
      add('fields', false, [type, field, form, wrapper, 'complete'], functions.declaration(type, read(wrap('source', type), field)));
    }
    for (const [typeWrapper, wrapType] of Object.entries(typeWrappers)) for (const [form, read] of Object.entries(readForms)) {
      add('fields', false, [type, field, form, 'type', typeWrapper], functions.declaration(wrapType(type), read('(source!)', field)));
      add('fields', true, [type, field, form, 'type_shadow', typeWrapper], `import type { ${type} as Raw } from './types.ts'; function outer() { type Raw = Display; ${functions.declaration(wrapType('Raw'), read('(source!)', field))} }`);
    }
    for (const [form, read] of Object.entries(readForms)) {
      add('fields', false, [type, field, form, 'cast_expression'], read(`(read() as ${type})`, field));
      add('fields', false, [type, field, form, 'cast_binding'], `const source = read() as ${type}; ${read('source', field)}`);
    }
  }
}
function fieldMatrix() { fieldCartesian(); fieldCompleteness(); }

const copies = {
  spread: value => `void { ...${value} };`,
  assign: value => `void Object.assign({}, ${value});`,
  entries: value => `void Object.entries(${value});`,
  keys: value => `void Object.keys(${value});`,
  values: value => `void Object.values(${value});`,
  clone: value => `void structuredClone(${value});`,
  json: value => `void JSON.stringify(${value});`,
  json_roundtrip: value => `void JSON.parse(JSON.stringify(${value}));`,
};
const objectMembers = {
  pair: value => `void ({ chosen: ${value} });`,
  computed: value => `void ({ [key]: ${value} });`,
  method: value => `void ({ chosen() { return ${value}; } });`,
  getter: value => `void ({ get chosen() { return ${value}; } });`,
  arrow: value => `void ({ chosen: () => ${value} });`,
};
function objectMemberMatrix() {
  for (const type of ['CezConfig', 'LaunchConfig', 'WorkflowDef', 'WorkflowStepDef', 'StartRunInput']) {
    for (const [form, object] of Object.entries(objectMembers)) for (const [wrapper, wrap] of Object.entries(wrappers)) {
      for (const [kind, enclose] of Object.entries(functions)) {
        add('capture', false, [type, 'object_member', form, wrapper, kind, 'owned'], enclose(type, object(wrap('source', type))));
        add('capture', true, [type, 'object_member', form, wrapper, kind, 'unrelated'], enclose('Display', object(wrap('source', 'Display'))));
        add('capture', true, [type, 'object_member', form, wrapper, kind, 'shadow'], `function outer(source: ${type}) { ${enclose('Display', object(wrap('source', 'Display')))} }`);
      }
    }
    for (const [kind, enclose] of Object.entries(functions)) {
      add('capture', false, [type, 'object_shorthand', kind], enclose(type, 'void ({ source });'));
      add('capture', true, [type, 'object_shorthand', kind, 'unrelated'], enclose('Display', 'void ({ source });'));
    }
  }
}
function captureMatrix() {
  for (const type of ['CezConfig', 'LaunchConfig', 'LaunchSource', 'ExecutionLaunch']) {
    for (const [operation, copy] of Object.entries(copies)) for (const [wrapper, wrap] of Object.entries(wrappers)) {
      for (const [kind, enclose] of Object.entries(functions)) {
        const axes = [type, operation, wrapper, kind];
        add('capture', false, [...axes, 'owned'], enclose(type, copy(wrap('source', type))));
        add('capture', true, [...axes, 'unrelated'], enclose('Display', copy(wrap('source', 'Display'))));
        add('capture', true, [...axes, 'value_shadow'], `function boundary(source: ${type}) { ${enclose('Display', copy(wrap('source', 'Display')))} }`);
        add('capture', true, [...axes, 'block_shadow'], enclose(type, `{ const source: Display = display(); ${copy(wrap('source', 'Display'))} }`));
        add('capture', true, [...axes, 'type_shadow'], `import type { ${type} as Raw } from './types.ts'; function boundary() { type Raw = Display; ${enclose('Raw', copy(wrap('source', 'Raw')))} }`);
      }
    }
  }
  for (const type of sourceTypes) {
    for (const [kind, enclose] of Object.entries(functions)) {
      add('capture', false, [type, kind, 'rest_parameter'], enclose(type, 'void source;').replace('source:', '{ ...source }:'));
    }
    for (const [wrapper, wrap] of Object.entries(typeWrappers)) {
      add('capture', false, [type, wrapper, 'root_alias'], `type Captured = ${wrap(type)};`);
      add('capture', false, [type, wrapper, 'import_alias'], `import type { ${type} as Raw } from './types.ts'; type Captured = ${wrap('Raw')};`);
      add('capture', false, [type, wrapper, 'import_type_alias'], `type Captured = ${wrap(`import('./types.ts').${type}`)};`);
      add('capture', true, [type, wrapper, 'structural_alias'], `type Captured = { status: string; display: '${type}' };`);
    }
    add('capture', true, [type, 'structural_lifecycle'], `type Lifecycle = ${type}['status'];`);
  }
  for (const operation of ['assign', 'entries', 'keys', 'values']) {
    for (const type of ['CezConfig', 'LaunchConfig']) for (const [kind, enclose] of Object.entries(functions)) {
      for (const [spelling, callee] of Object.entries({ plain: `Object.${operation}`, bracket: `Object['${operation}']`, paren: `(Object.${operation})`, nonnull: `Object.${operation}!`, recursive: `((Object['${operation}'])!)` })) {
        const args = operation === 'assign' ? '{}, source' : 'source';
        add('capture', false, [type, operation, kind, 'callee', spelling], enclose(type, `void ${callee}(${args});`));
        add('capture', true, [type, operation, kind, 'callee_control', spelling], enclose('Display', `void ${callee}(${args});`));
      }
    }
  }
}
function typeShadowMatrix() {
  for (const type of sourceTypes) for (const [wrapper, wrap] of Object.entries(typeWrappers)) {
    for (const [kind, enclose] of Object.entries(functions)) {
      const axes = [type, wrapper, kind, 'nearest_type'];
      add('capture', false, [...axes, 'inner_owned_alias'], `type Raw = Display; ${enclose('Display', `type Raw = ${wrap(type)};`)}`);
      add('capture', false, [...axes, 'inner_owned_import_type'], `type ${type} = Display; ${enclose('Display', `type ${type} = ${wrap(`import('./types.ts').${type}`)};`)}`);
      add('capture', true, [...axes, 'renamed_import_shadow'], `import type { ${type} as Raw } from './types.ts'; ${enclose('Display', `type Raw = Display; type Copy = ${wrap('Raw')};`)}`);
      add('capture', true, [...axes, 'canonical_shadow'], enclose('Display', `type ${type} = Display; type Copy = ${wrap(type)};`));
      add('capture', true, [...axes, 'canonical_import_shadow'], `import type { ${type} } from './types.ts'; ${enclose('Display', `type ${type} = Display; type Copy = ${wrap(type)};`)}`);
    }
  }
  for (const [type, field] of Object.entries(representativeFields)) {
    for (const [kind, enclose] of Object.entries(functions)) for (const [form, read] of Object.entries(readForms)) {
      // Use a separate receiver name so destructuring's selected binding stays distinct.
      const safeBody = `type ${type} = Display; const receiver: ${type} = display(); ${read('receiver', field)}`;
      add('fields', true, [type, field, kind, form, 'canonical_type_shadow'], enclose('Display', safeBody));
      add('fields', true, [type, field, kind, form, 'canonical_import_type_shadow'], `import type { ${type} } from './types.ts'; ${enclose('Display', safeBody)}`);
    }
  }
}
const memberPaths = [['config'], ['inner', 'options'], ['outer', 'layer', 'inner', 'chosen']];
function nestedType(keys, type) { return keys.reduceRight((value, key) => `{ ${key}: ${value} }`, type); }
function memberEnclosure(shape, keys, type, body) {
  const [name, ...rest] = keys;
  const propertyType = nestedType(rest, type);
  const containerType = nestedType(keys, type);
  if (shape === 'inline') return `function choose(holder: ${containerType}) { ${body('holder', containerType)} }`;
  const declaration = shape === 'constructor' ? `constructor(private ${name}: ${propertyType}) {}` : `${name}!: ${propertyType};`;
  return `class Holder { ${declaration} choose() { ${body('this', containerType)} } }`;
}
function memberBody(parent, containerType, keys, type, wrap, location, operation) {
  const owner = location === 'parent' ? wrap(parent, containerType) : parent;
  const receiver = `${owner}.${keys.join('.')}`;
  return operation(location === 'leaf' ? wrap(receiver, type) : receiver);
}
function memberCases(family, type, operationName, operation) {
  for (const keys of memberPaths) for (const shape of ['inline', 'class', 'constructor']) {
    for (const [wrapper, wrap] of Object.entries(wrappers)) for (const location of ['parent', 'leaf']) {
      for (const [owned, valueType] of [[true, type], [false, 'Display']]) {
        const code = memberEnclosure(shape, keys, valueType, (parent, containerType) => memberBody(parent, containerType, keys, valueType, wrap, location, operation));
        addMember(family, !owned, [type, operationName, 'member_path', keys.join('.'), shape, wrapper, location, owned ? 'owned' : 'unrelated'], code, keys.length);
      }
    }
  }
}
function memberSiblingCases(family, type, operationName, operation) {
  for (const keys of memberPaths) for (const [wrapper, wrap] of Object.entries(wrappers)) {
    for (const location of ['parent', 'leaf']) for (const branch of ['owned', 'view']) {
      const containerType = `{ owned: ${nestedType(keys, type)}; view: ${nestedType(keys, 'Display')} }`;
      const valueType = branch === 'owned' ? type : 'Display';
      const body = memberBody('holder', containerType, [branch, ...keys], valueType, wrap, location, operation);
      addMember(family, branch === 'view', [type, operationName, 'member_sibling', keys.join('.'), wrapper, location, branch], `function choose(holder: ${containerType}) { ${body} }`, keys.length + 1);
    }
  }
}
function typedMemberMatrix() {
  for (const [type, field] of Object.entries({ CezConfig: 'baseBranch', WorkflowStepDef: 'model', StartRunInput: 'model', LaunchConfig: 'defaultRunner' })) {
    for (const [form, read] of Object.entries(readForms)) {
      const operation = receiver => read(receiver, field);
      memberCases('fields', type, `${field}/${form}`, operation);
      memberSiblingCases('fields', type, `${field}/${form}`, operation);
    }
  }
  for (const type of ['CezConfig', 'LaunchConfig']) for (const [name, copy] of Object.entries(copies)) {
    memberCases('capture', type, name, copy);
    memberSiblingCases('capture', type, name, copy);
  }
}
const lexicalBindings = {
  catch: (name, body) => `try { throw display(); } catch (${name}) { ${body} }`,
  for_of: (name, body, field) => `for (const ${name} of [{ ${field}: 'view' }]) { ${body} }`,
  for_in: (name, body) => `for (const ${name} in { view: true }) { ${body} }`,
  for_let: (name, body, field) => `for (let ${name} = { ${field}: 'view' }; keepGoing(); advance()) { ${body} }`,
  block_let: (name, body, field) => `{ let ${name} = { ${field}: 'view' }; ${body} }`,
  block_const: (name, body, field) => `{ const ${name} = { ${field}: 'view' }; ${body} }`,
  block_function: (name, body) => `{ function ${name}() { return display(); } ${body} }`,
};
function lexicalValueFieldMatrix() {
  for (const [type, field] of Object.entries(representativeFields)) for (const [form, read] of Object.entries(readForms)) {
    for (const [wrapper, wrap] of Object.entries(wrappers)) for (const [binding, enclose] of Object.entries(lexicalBindings)) {
      for (const sameName of [true, false]) {
        const body = read(wrap('source', sameName ? 'Display' : type), field);
        const inner = enclose(sameName ? 'source' : 'view', body, field);
        add('fields', sameName, [type, field, form, wrapper, 'lexical_value', binding, sameName ? 'same_name' : 'different_name'], functions.declaration(type, inner));
      }
    }
  }
}
function lexicalValueCaptureMatrix() {
  for (const type of ['CezConfig', 'LaunchConfig']) for (const [operation, copy] of Object.entries(copies)) {
    for (const [wrapper, wrap] of Object.entries(wrappers)) for (const [binding, enclose] of Object.entries(lexicalBindings)) {
      for (const sameName of [true, false]) {
        const body = copy(wrap('source', sameName ? 'Display' : type));
        const inner = enclose(sameName ? 'source' : 'view', body, 'baseBranch');
        add('capture', sameName, [type, operation, wrapper, 'lexical_value', binding, sameName ? 'same_name' : 'different_name'], functions.declaration(type, inner));
      }
    }
  }
}
function lexicalValueSelectorMatrix() {
  for (const selector of ['loadConfig', 'loadWorkflows']) for (const [wrapper, wrap] of Object.entries(calleeWrappers)) {
    for (const [binding, enclose] of Object.entries(lexicalBindings)) for (const sameName of [true, false]) {
      const body = `void ${wrap(selector)}(source);`;
      const inner = enclose(sameName ? selector : 'view', body, 'model');
      add('selectors', sameName, [selector, wrapper, 'lexical_value', binding, sameName ? 'same_name' : 'different_name'], functions.declaration('Display', inner));
    }
  }
}
const hoistedBindings = {
  same_binding_var: (type, body) => functions.declaration(type, `var source; ${body}`),
  same_binding_for_var: (type, body) => functions.declaration(type, `for (var source of [source]) { ${body} }`),
  sibling_block_typed_var: (type, body) => `function choose() { { var source: ${type} = read(); } ${body} }`,
  standard_for_typed_var: (type, body) => `function choose() { for (var source: ${type} = read(); keepGoing();) { ${body} } }`,
};
const unrelatedHoistedBindings = {
  nested_unknown_var: (type, body) => functions.declaration(type, `function inner() { { var source = display(); } ${body} }`),
  nested_for_var: (type, body, field) => functions.declaration(type, `function inner() { for (var source of [{ ${field}: 'view' }]) { ${body} } }`),
  block_class: (type, body, field) => functions.declaration(type, `{ class source { static ${field} = 'view'; } ${body} }`),
  named_class: (type, body, field) => functions.declaration(type, `const local = class source { static ${field} = 'view'; choose() { ${body} } };`),
  block_enum: (type, body, field) => functions.declaration(type, `{ enum source { ${field} } ${body} }`),
};
function hoistedMatrixCells(family, type, operationName, field, operation) {
  for (const [wrapper, wrap] of Object.entries(wrappers)) {
    for (const [binding, enclose] of Object.entries(hoistedBindings)) {
      add(family, false, [type, operationName, wrapper, 'hoisted_value', binding], enclose(type, operation(wrap('source', type)), field));
    }
    for (const [binding, enclose] of Object.entries(unrelatedHoistedBindings)) {
      add(family, true, [type, operationName, wrapper, 'hoisted_value', binding], enclose(type, operation(wrap('source', 'Display')), field));
    }
    // A var loop binder is function-scoped and suppresses conventional-name inference.
    add(family, true, [type, operationName, wrapper, 'hoisted_value', 'canonical_unknown_for_var'], `function choose() { for (var input of [{ ${field}: 'view' }]) { ${operation(wrap('input', 'Display'))} } }`);
  }
}
function hoistedValueMatrix() {
  for (const [type, field] of Object.entries(representativeFields)) for (const [form, read] of Object.entries(readForms)) {
    hoistedMatrixCells('fields', type, `${field}/${form}`, field, receiver => read(receiver, field));
  }
  for (const type of ['CezConfig', 'LaunchConfig']) for (const [name, copy] of Object.entries(copies)) {
    hoistedMatrixCells('capture', type, name, 'baseBranch', copy);
  }
}
const selectors = 'loadWorkflows stepToolGrant loadConfig agentModelsLocked readAgentModelProvider normalizeModelForBackend workerIdentity workerStepIdentity ownedWorkflow continuationDefStep resolveProfileEnvForRoot boundWorkerAccountEnv captureWorkerAccount discoverSkills filterDisabledTeamSkills filterDisabledTeamSources readDisabledTeamSkills readDisabledSkillsReposSync readProjectUiState readProjectUiStateSync getTeamSkillsCached resolveAttachmentPath readPersistedAttachments accountHeldFor executionAccount queuedRecoveryInput'.split(' ');
const modules = 'config skills skills-remote agent-model-policy models agent-profiles execution-identity run-scheduling execution-account ui-state model-identity attachment-path load types'.split(' ');
const moduleSelectors = { config: 'loadConfig', skills: 'discoverSkills', 'skills-remote': 'getTeamSkillsCached', 'agent-model-policy': 'agentModelsLocked', models: 'readAgentModelProvider', 'agent-profiles': 'resolveProfileEnvForRoot', 'execution-identity': 'workerIdentity', 'run-scheduling': 'accountHeldFor', 'execution-account': 'executionAccount', 'ui-state': 'readProjectUiState', 'model-identity': 'normalizeModelForBackend', 'attachment-path': 'resolveAttachmentPath', load: 'loadWorkflows', types: 'stepToolGrant' };
const calleeWrappers = { plain: name => name, paren: name => `(${name})`, nonnull: name => `${name}!`, cast: name => `(${name} as typeof ${name})`, recursive: name => `((${name} as typeof ${name})!)` };
function selectorMatrix() {
  for (const selector of selectors) for (const [wrapper, wrap] of Object.entries(calleeWrappers)) {
    for (const [kind, enclose] of Object.entries(functions)) {
      add('selectors', false, [selector, wrapper, kind], enclose('Display', `void ${wrap(selector)}(source);`));
      add('selectors', true, [selector, wrapper, kind, 'unrelated'], enclose('Display', `void ${wrap('displayValue')}(source);`));
      add('selectors', true, [selector, wrapper, kind, 'parameter_shadow'], `function boundary(${selector}: DisplayFn) { ${enclose('Display', `void ${wrap(selector)}(source);`)} }`);
      add('selectors', true, [selector, wrapper, kind, 'function_shadow'], enclose('Display', `function ${selector}(...args: unknown[]) { return args; } void ${wrap(selector)}(source);`));
      add('selectors', true, [selector, wrapper, kind, 'constant_shadow'], enclose('Display', `const ${selector}: DisplayFn = displayValue; void ${wrap(selector)}(source);`));
    }
  }
  for (const module of modules) for (const style of ['default', 'named', 'namespace', 'dynamic', 'star_export']) {
    const imported = { default: `import owned from '../${module}.ts';`, named: `import { ${moduleSelectors[module]} as owned } from '../${module}.ts';`, namespace: `import * as owned from '../${module}.ts';`, dynamic: `void import('../${module}.ts');`, star_export: `export * from '../${module}.ts';` };
    add('selectors', false, [module, style, 'owned'], imported[style]);
    if (style !== 'named') {
      add('selectors', true, [module, style, 'similar_prefix'], imported[style].replace(`../${module}.ts`, `../display-${module}.ts`));
      add('selectors', true, [module, style, 'similar_suffix'], imported[style].replace(`../${module}.ts`, `../${module}.ts.bak`));
    }
  }
}

const genericOwners = {
  function: (name, body) => `function choose<${name}>(source: ${name}) { ${body} }`,
  method: (name, body) => `class Holder { choose<${name}>(source: ${name}) { ${body} } }`,
  class: (name, body) => `class Holder<${name}> { choose(source: ${name}) { ${body} } }`,
  interface: (name, body) => `interface Holder<${name}> { choose: (source: ${name}) => void; chosen: ${body} }`,
  alias: (name, body) => `type Holder<${name}> = ${body};`,
};
function genericShadowMatrix() {
  for (const type of sourceTypes) for (const [kind, enclose] of Object.entries(genericOwners)) {
    for (const imported of [false, true]) {
      const prefix = imported ? `import type { ${type} as Raw } from './types.ts';` : '';
      const name = imported ? 'Raw' : type;
      const typeBody = ['interface', 'alias'].includes(kind);
      const body = typeBody ? name : `type Copy = ${name};`;
      add('capture', true, [type, 'generic_shadow', kind, String(imported), 'alias'], prefix + enclose(name, body));
      if (typeBody) continue;
      const field = fields[type]?.split(' ')[0] || 'model';
      add('fields', true, [type, 'generic_shadow', kind, String(imported), 'field'], prefix + enclose(name, `void source.${field};`));
      add('capture', true, [type, 'generic_shadow', kind, String(imported), 'copy'], prefix + enclose(name, 'void {...source};'));
      add('fields', false, [type, 'generic_other_name', kind, String(imported)], prefix + enclose('View', `const chosen: ${name} = read(); void chosen.${field};`));
    }
  }
}
const thisBindings = {
  object_method: body => `const view = { source: display(), choose() { ${body} } };`,
  function_expression: body => `const choose = function() { ${body} };`,
  function_declaration: body => `function choose() { ${body} }`,
  class_body: body => `class Inner { source = display(); choose = () => { ${body} }; }`,
  arrow: body => `const choose = () => { ${body} };`,
  object_parameter: body => `const view = { choose(value = (() => { ${body} })()) {} };`,
  class_parameter: body => `class Inner { choose(value = (() => { ${body} })()) {} }`,
  class_static: body => `class Inner { static { ${body} } }`,
};
function thisBindingMatrix() {
  for (const [type, field] of Object.entries(representativeFields)) for (const [kind, enclose] of Object.entries(thisBindings)) {
    for (const [form, read] of Object.entries(readForms)) {
      add('fields', kind !== 'arrow', [type, 'this_binding', kind, form], `class Outer { source!: ${type}; choose() { ${enclose(read('this.source', field))} } }`);
    }
    if (!['CezConfig', 'LaunchConfig'].includes(type)) continue;
    for (const [operation, copy] of Object.entries(copies)) {
      add('capture', kind !== 'arrow', [type, 'this_binding', kind, operation], `class Outer { source!: ${type}; choose() { ${enclose(copy('this.source'))} } }`);
    }
  }
}
function assertedHolderMatrix() {
  for (const [type, field] of Object.entries(representativeFields)) {
    for (const expression of ['get()', 'values[0]', 'left || right', 'holder']) {
      for (const wrapper of ['cast', 'angle', 'satisfies', 'recursive']) for (const owned of [true, false]) {
        const receiver = wrappers[wrapper](`(${expression})`, `{ config: ${owned ? type : 'Display'} }`) + '.config';
        for (const [form, read] of Object.entries(readForms)) {
          add('fields', !owned, [type, 'asserted_holder', expression, wrapper, form, String(owned)], `function choose() { ${read(receiver, field)} }`);
        }
        if (!['CezConfig', 'LaunchConfig'].includes(type)) continue;
        for (const [operation, copy] of Object.entries(copies)) {
          add('capture', !owned, [type, 'asserted_holder', expression, wrapper, operation, String(owned)], `function choose() { ${copy(receiver)} }`);
        }
      }
    }
  }
}
// Bindings inside a generic owner's body take precedence over its type parameter.
function nearerTypeCells(type, field, kind, enclose, declaration) {
  const owned = declaration === 'alias' ? `type Shadow = {config:${type}};` : `interface Shadow {config:${type}}`;
  const inner = body => enclose('Shadow', `{ ${owned} let data!:Shadow; ${body} }`);
  for (const [form, read] of Object.entries(readForms)) {
    add('fields', false, [type, 'nearer_type', kind, declaration, form], inner(read('data.config', field)));
  }
  if (!['CezConfig', 'LaunchConfig'].includes(type)) return;
  for (const [operation, copy] of Object.entries(copies)) {
    add('capture', false, [type, 'nearer_type', kind, declaration, operation], inner(copy('data.config')));
  }
}
function nearerTypeMatrix() {
  for (const [type, field] of Object.entries(representativeFields)) {
    for (const kind of ['function', 'method', 'class']) for (const declaration of ['alias', 'interface']) {
      nearerTypeCells(type, field, kind, genericOwners[kind], declaration);
    }
  }
}
const computedMethods = {
  method: name => `[${name}]() { return 1; }`,
  getter: name => `get [${name}]() { return 1; }`,
  setter: name => `set [${name}](value: unknown) {}`,
  generator: name => `*[${name}]() { yield 1; }`,
};
const computedHolders = {
  field: type => `source!:${type};`,
  parameter: type => `constructor(private source:${type}) {}`,
};
const computedSources = {
  member: value => value,
  arrow: value => `(()=>${value})()`,
  function: value => `(function() { return ${value}; })()`,
};
function computedNameCells(type, field, location, kind, method, holder) {
  for (const [source, expression] of Object.entries(computedSources)) {
    const member = method(expression(`this.source.${field}`));
    const inner = location === 'object' ? `return { ${member} };` : `return class Inner { ${member} };`;
    add('fields', source === 'function', [type, 'computed_name', location, kind, source, holder],
      `class Outer { ${computedHolders[holder](type)} choose() { ${inner} } }`);
  }
}
function computedNameMatrix() {
  for (const [type, field] of Object.entries(representativeFields)) {
    for (const location of ['object', 'class']) for (const [kind, method] of Object.entries(computedMethods)) {
      for (const holder of Object.keys(computedHolders)) computedNameCells(type, field, location, kind, method, holder);
    }
  }
}
nearerTypeMatrix(); computedNameMatrix();
dimensions.nearerTypeBindings = ['alias', 'interface'];
dimensions.computedMethodKinds = Object.keys(computedMethods);
dimensions.computedThisSources = Object.keys(computedSources);
genericShadowMatrix(); thisBindingMatrix(); assertedHolderMatrix();
dimensions.genericOwners = Object.keys(genericOwners);
dimensions.thisBindings = Object.keys(thisBindings);
dimensions.assertedHolderExpressions = ['get()', 'values[0]', 'left || right', 'holder'];

fieldMatrix(); captureMatrix(); objectMemberMatrix(); selectorMatrix(); typeShadowMatrix(); typedMemberMatrix();
lexicalValueFieldMatrix(); lexicalValueCaptureMatrix(); lexicalValueSelectorMatrix(); hoistedValueMatrix();
for (const cell of documentedLimits) parse(cell.code, { sourceType: 'module', plugins: ['typescript'] });
// TypeScript 7 exposes no stable JS parser API; use the repository's pinned TS syntax reader.
for (const [family, cases] of Object.entries(generated)) for (const [validity, snippets] of Object.entries(cases)) {
  for (const source of snippets) {
    try { parse(source, { sourceType: 'module', plugins: ['typescript'], allowAwaitOutsideFunction: true }); }
    catch (error) { throw new Error(`${family}/${validity}: malformed generated cell: ${source}\n${error.message}`, { cause: error }); }
  }
}
dimensions.fields = fields;
dimensions.sourceTypes = sourceTypes;
dimensions.typedMemberPaths = memberPaths;
dimensions.lexicalValueBindings = Object.keys(lexicalBindings);
dimensions.hoistedValueBindings = Object.keys(hoistedBindings);
dimensions.unrelatedHoistedValueBindings = Object.keys(unrelatedHoistedBindings);
dimensions.representativeFieldCartesian = representativeFields;
dimensions.readForms = Object.keys(readForms);
dimensions.receiverWrappers = Object.keys(wrappers);
dimensions.typeWrappers = Object.keys(typeWrappers);
dimensions.functionKinds = Object.keys(functions);
dimensions.lexicalCases = ['owned', 'unrelated', 'value_shadow', 'block_shadow', 'type_shadow'];
dimensions.copyOperations = Object.keys(copies);
dimensions.selectors = selectors;
dimensions.modules = modules;
// The corpus exists only in memory. The Vitest batch scan owns its executable proof.
module.exports = { generated, documentedLimits, dimensions };
if (require.main === module) console.log(JSON.stringify({
  documentedLimitCount: documentedLimits.length,
  families: Object.fromEntries(Object.entries(generated).map(([name, cells]) => [name, { valid: cells.valid.length, invalid: cells.invalid.length }])),
}, null, 2));
