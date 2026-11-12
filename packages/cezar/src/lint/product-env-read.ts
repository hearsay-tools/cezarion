import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import type { Node, TSTypeAliasDeclaration, TSTypeReference } from '@babel/types';
import { property, unwrapped, visit } from './home-boundary.ts';
import { lineAt, repoRoot, type SourceRule } from './source-rule.ts';
import { productEnvCalls, scannedEnvFile } from './undocumented-env-name.ts';

export const productEnvBaselineFile = 'packages/cezar/src/lint/product-env-read.baseline.json';
const ACCESSOR = 'packages/cezar/src/core/product-env.ts';
export interface EnvRead { form: 'dot' | 'bracket' | 'computed' | 'destructure' | 'helper-dynamic'; name: string; offset: number; expression?: string }
export interface EnvReadAllowance { file: string; form: EnvRead['form']; name: string; reads: number }

export const productEnvFile = (file: string): boolean => file !== ACCESSOR && scannedEnvFile(file);
export function readProductEnvBaseline(path = join(repoRoot, productEnvBaselineFile)): EnvReadAllowance[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { entries: EnvReadAllowance[] }).entries;
}

const productName = (name: string | undefined): boolean => /^(CEZ|HSQ)_[A-Z0-9_]+$/.test(name ?? '');
const member = (node: Node): boolean => node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression';

type EnvReference = 'global' | 'process' | 'env';
type EnvBindings = Map<string, EnvReference>;
type TypeAliases = Map<string, TSTypeAliasDeclaration>;
const OBJECT_UTILITIES = new Set(['Partial', 'Readonly', 'Required', 'Pick', 'Omit', 'NonNullable']);

function childReference(owner: EnvReference | undefined, key: string | undefined): EnvReference | undefined {
  if (owner === 'global' && key === 'process') return 'process';
  // As with member reads, an env property is conservatively treated as an env source.
  if (key === 'env') return 'env';
  return undefined;
}

function reference(node: Node | null | undefined, aliases: EnvBindings): EnvReference | undefined {
  if (!node) return undefined;
  const target = unwrapped(node);
  if (target.type === 'Identifier') {
    if (aliases.has(target.name)) return aliases.get(target.name);
    if (target.name === 'process') return 'process';
    if (target.name === 'globalThis') return 'global';
    if (/env$/i.test(target.name)) return 'env';
  }
  if (target.type === 'TSQualifiedName') return childReference(reference(target.left, aliases), target.right.name);
  if (target.type === 'MemberExpression' || target.type === 'OptionalMemberExpression') {
    return childReference(reference(target.object, aliases), property(target));
  }
  return undefined;
}

/** Resolve only object-preserving type forms, without requiring the TypeScript checker. */
function typeReference(type: Node | null | undefined, aliases: TypeAliases, parameters = new Map<string, EnvReference | undefined>(), seen = new Set<Node>()): EnvReference | undefined {
  if (!type || seen.has(type)) return undefined;
  const next = new Set(seen).add(type);
  if (type.type === 'TSTypeReference') return namedTypeReference(type, aliases, parameters, next);
  if (type.type === 'TSTypeQuery') return reference(type.exprName, new Map());
  if (type.type === 'TSParenthesizedType') return typeReference(type.typeAnnotation, aliases, parameters, next);
  if (type.type === 'TSUnionType' || type.type === 'TSIntersectionType') {
    const refs = type.types.map(part => typeReference(part, aliases, parameters, next));
    return refs.find(ref => ref === 'env') ?? refs.find(ref => ref !== undefined);
  }
  if (type.type === 'TSIndexedAccessType') {
    const owner = typeReference(type.objectType, aliases, parameters, next);
    const key = type.indexType.type === 'TSLiteralType' ? property(type.indexType.literal) : undefined;
    return owner === undefined ? undefined : childReference(owner, key);
  }
  // Arrays, tuples, keyof and scalar types do not describe an env object.
  return undefined;
}

function namedTypeReference(type: TSTypeReference, aliases: TypeAliases, parameters: Map<string, EnvReference | undefined>, seen: Set<Node>): EnvReference | undefined {
  const name = property(type.typeName.type === 'TSQualifiedName' ? type.typeName.right : type.typeName)!;
  if (parameters.has(name)) return parameters.get(name);
  if (name === 'ProcessEnv') return 'env';
  if (name === 'Process') return 'process';
  if (OBJECT_UTILITIES.has(name)) return typeReference(type.typeArguments?.params[0], aliases, parameters, seen);
  const alias = aliases.get(name);
  if (!alias) return undefined;
  const substitutions = new Map(parameters);
  for (const [index, parameter] of (alias.typeParameters?.params ?? []).entries()) {
    const argument = type.typeArguments?.params[index];
    substitutions.set(parameter.name.name, argument
      ? typeReference(argument, aliases, parameters, seen)
      : typeReference(parameter.default, aliases, substitutions, seen));
  }
  return typeReference(alias.typeAnnotation, aliases, substitutions, seen);
}

function typedReference(node: Node, aliases: TypeAliases): EnvReference | undefined {
  if (!('typeAnnotation' in node) || node.typeAnnotation?.type !== 'TSTypeAnnotation') return undefined;
  return typeReference(node.typeAnnotation.typeAnnotation, aliases);
}

/** Walk the pattern with its source, including defaults and copies made by rest bindings. */
function patternReads(pattern: Node, owner: EnvReference | undefined, aliases: EnvBindings, bind = false): EnvRead[] {
  if (pattern.type === 'AssignmentPattern') return patternReads(pattern.left, owner ?? reference(pattern.right, aliases), aliases, bind);
  if (pattern.type === 'Identifier') {
    if (bind && owner) aliases.set(pattern.name, owner);
    return [];
  }
  if (pattern.type !== 'ObjectPattern') return [];
  return pattern.properties.flatMap(field => {
    if (field.type === 'RestElement') {
      const reads: EnvRead[] = owner === 'env' ? [{ form: 'computed', name: '*', offset: field.start ?? 0 }] : [];
      return [...reads, ...patternReads(field.argument, owner, aliases, bind)];
    }
    const name = field.computed && field.key.type === 'Identifier' ? undefined : property(field.key);
    const reads: EnvRead[] = (owner === 'env' && productName(name)) || (owner !== undefined && name === undefined)
      ? [{ form: name === undefined ? 'computed' : 'destructure', name: name ?? '*', offset: field.start ?? 0 }] : [];
    return [...reads, ...patternReads(field.value, childReference(owner, name), aliases, bind)];
  });
}

function bindingReads(node: Node, aliases: EnvBindings, types: TypeAliases, bind = false): EnvRead[] {
  if (node.type === 'VariableDeclarator') return patternReads(node.id, typedReference(node.id, types) ?? reference(node.init, aliases), aliases, bind);
  if (node.type === 'AssignmentExpression') return patternReads(node.left, reference(node.right, aliases), aliases, bind);
  if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') return patternReads(node.left, undefined, aliases, bind);
  if (!('params' in node) || !Array.isArray(node.params)) return [];
  return node.params.flatMap(param => {
    const pattern = param.type === 'AssignmentPattern' ? param.left : param;
    return patternReads(param, typedReference(pattern, types), aliases, bind);
  });
}

/** Track env, process and global aliases, including aliases nested in destructuring. */
function envBindings(ast: Node, types: TypeAliases): EnvBindings {
  const aliases: EnvBindings = new Map();
  visit(ast, node => {
    const typed = typedReference(node, types);
    if (node.type === 'Identifier' && typed) aliases.set(node.name, typed);
    bindingReads(node, aliases, types, true);
  });
  return aliases;
}

function markWriteTarget(node: Node | null, targets: Set<Node>): void {
  if (!node) return;
  const target = unwrapped(node);
  if (member(target)) { targets.add(target); return; }
  if (target.type === 'ObjectPattern') {
    for (const field of target.properties) markWriteTarget(field.type === 'RestElement' ? field.argument : field.value, targets);
  }
  if (target.type === 'ArrayPattern') for (const item of target.elements) markWriteTarget(item, targets);
  if (target.type === 'AssignmentPattern') markWriteTarget(target.left, targets);
  if (target.type === 'RestElement') markWriteTarget(target.argument, targets);
}

/** Only assignment without a read and delete are exempt. += and ++ read the old value. */
function writeTargets(ast: Node): Set<Node> {
  const targets = new Set<Node>();
  const mark = (node: Node) => markWriteTarget(node, targets);
  visit(ast, node => {
    if (node.type === 'AssignmentExpression' && node.operator === '=') mark(node.left);
    if (node.type === 'UnaryExpression' && node.operator === 'delete') mark(node.argument);
    if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') mark(node.left);
  });
  return targets;
}

function memberRead(node: Node, aliases: EnvBindings, writes: Set<Node>, source: string, staticNames: Map<string, string>): EnvRead[] {
  if ((node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') || writes.has(node)) return [];
  const name = property(node) ?? (node.computed && node.property.type === 'Identifier' ? staticNames.get(node.property.name) : undefined);
  if (!productName(name) && !(node.computed && name === undefined && reference(node.object, aliases) === 'env')) return [];
  return [{ form: node.computed ? name === undefined ? 'computed' : 'bracket' : 'dot', name: name ?? '*', offset: node.start ?? 0, expression: source.slice(node.start ?? 0, node.end ?? 0) }];
}

/** Only immutable literal strings can identify a computed environment key. */
function literalEnvKey(node: Node, bindings: Map<string, Node>, seen = new Set<string>()): string | undefined {
  const target = unwrapped(node);
  if (target.type === 'StringLiteral') return target.value;
  if (target.type === 'TemplateLiteral' && target.expressions.length === 0) return target.quasis[0]?.value.cooked ?? undefined;
  if (target.type !== 'Identifier' || seen.has(target.name)) return undefined;
  const bound = bindings.get(target.name);
  return bound ? literalEnvKey(bound, bindings, new Set(seen).add(target.name)) : undefined;
}

/** Duplicate or shadowed bindings stay unknown rather than borrowing an outer value. */
function staticEnvNames(ast: Node): Map<string, string> {
  const constants = new Map<string, Node>();
  const counts = new Map<string, number>();
  const count = (pattern: Node) => visit(pattern, node => {
    if (node.type === 'Identifier') counts.set(node.name, (counts.get(node.name) ?? 0) + 1);
  });
  visit(ast, node => {
    if (node.type === 'VariableDeclaration') {
      for (const declaration of node.declarations) {
        count(declaration.id);
        if (node.kind === 'const' && declaration.id.type === 'Identifier' && declaration.init) constants.set(declaration.id.name, declaration.init);
      }
    }
    if ('params' in node && Array.isArray(node.params)) node.params.forEach(count);
    if (node.type === 'CatchClause' && node.param) count(node.param);
    if (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier') count(node.local);
    if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration' || node.type === 'FunctionExpression') && node.id) count(node.id);
  });
  for (const [name, total] of counts) if (total !== 1) constants.delete(name);
  const names = new Map<string, string>();
  for (const [name, value] of constants) {
    const literal = literalEnvKey(value, constants);
    if (literal !== undefined) names.set(name, literal);
  }
  return names;
}

/** AST scanning avoids strings/comments, supports env arguments, brackets, aliases and destructuring. */
export function productEnvReads(source: string, file = 'file.ts'): EnvRead[] {
  const ast = parse(source, { sourceType: 'unambiguous', plugins: ['typescript', ...(/\.[cm]?[jt]sx$/.test(file) ? ['jsx' as const] : [])] });
  const types: TypeAliases = new Map();
  visit(ast, node => {
    if (node.type === 'TSTypeAliasDeclaration') types.set(node.id.name, node);
  });
  const staticNames = staticEnvNames(ast);
  const aliases = envBindings(ast, types);
  const writes = writeTargets(ast);
  const reads: EnvRead[] = [];
  visit(ast, node => {
    reads.push(...memberRead(node, aliases, writes, source, staticNames));
    reads.push(...bindingReads(node, aliases, types));
  });
  for (const call of productEnvCalls(ast)) {
    if (call.suffix === undefined) reads.push({ form: 'helper-dynamic', name: '*', offset: call.offset });
  }
  return reads.sort((a, b) => a.offset - b.offset);
}

/** Permanent non-setting reads, separate from the migration baseline. Exact expressions
 * keep new indexing sites visible; named product settings can never use this exemption. */
export const nonSettingEnvReads = [
  { file: 'packages/cezar/src/ci-wait/tool-catalog.ts', form: 'computed', expression: 'env[preferred]', reason: 'Include a defined preferred controller entry in native adapter allowlists, including clears.' },
  { file: 'packages/cezar/src/core/agent-env.ts', form: 'computed', expression: 'source[name]', reason: 'Generic case-insensitive Bedrock/Vertex third-party toggle lookup.' },
  { file: 'packages/cezar/src/core/cursor-print-runner.ts', form: 'computed', expression: 'this.spec.env?.[name]', reason: 'Forward controller tool-authority entries to the native MCP adapter.' },
  { file: 'packages/cezar/src/home/kind-roots.ts', form: 'computed', expression: 'env[name]', reason: 'XDG kind-root lookup; not a product setting.' },
  { file: 'packages/cezar/src/home/resolve.ts', form: 'computed', expression: 'env[name]', reason: 'Project HOME_LAYOUT_ENV OS/XDG roots into the layout resolver.' },
  { file: 'packages/cezar/scripts/benchmark-workspace-events.ts', form: 'computed', expression: 'process.env[name]', reason: 'Snapshot exact names for sandbox restoration, without prefix precedence.' },
  { file: 'packages/cezar/scripts/benchmark-workspace-events.ts', form: 'computed', expression: 'savedEnv[name]', reason: 'Restore the original sandbox environment snapshot.' },
  { file: 'packages/cezar/scripts/mock-ci-tool.mjs', form: 'computed', expression: 'process.env[name]', reason: 'Native fixture MCP environment interpolation and allowlist forwarding.' },
  { file: 'packages/cezar/scripts/mock-env-record.mjs', form: 'computed', expression: 'process.env[name]', reason: 'Fixture records exact configured environment names.' },
] as const;

export const mockEnvReadExemption = {
  path: /^packages\/cezar\/scripts\/mock-[^/]+\.mjs$/,
  name: /^CEZ_MOCK_[A-Z0-9_]+$/,
  reason: 'Native mock controls are test fixtures, never operator product settings.',
};

export function nonSettingEnvRead(file: string, site: EnvRead): boolean {
  if (mockEnvReadExemption.path.test(file) && mockEnvReadExemption.name.test(site.name)) return true;
  // Only anonymous computed transport/lookups qualify. A literal product name never does.
  return site.name === '*' && site.form === 'computed' && nonSettingEnvReads.some(entry =>
    entry.file === file && entry.form === site.form && entry.expression === site.expression);
}

const key = (site: Pick<EnvRead, 'form' | 'name'>) => `${site.form}:${site.name}`;
let baseline: EnvReadAllowance[] | undefined;
export function scanProductEnvReads(file: string, source: string, allowances = (baseline ??= readProductEnvBaseline())): EnvRead[] {
  if (!productEnvFile(file)) return [];
  const counts = new Map(allowances.filter(entry => entry.file === file).map(entry => [key(entry), entry.reads]));
  return productEnvReads(source, file).filter(site => !nonSettingEnvRead(file, site)).filter(site => {
    const remaining = counts.get(key(site)) ?? 0;
    counts.set(key(site), remaining - 1);
    return remaining <= 0;
  });
}

/** Entries only shrink; CI checks growth against the committed baseline at the merge base. */
export function staleProductEnvReads(root = repoRoot): string[] {
  const entries = readProductEnvBaseline(join(root, productEnvBaselineFile));
  const sources = new Map<string, EnvRead[]>();
  const seen = new Set<string>();
  return entries.flatMap(entry => {
    if (!sources.has(entry.file)) {
      const path = join(root, entry.file);
      sources.set(entry.file, existsSync(path) ? productEnvReads(readFileSync(path, 'utf8'), entry.file) : []);
    }
    const count = sources.get(entry.file)!.filter(site => key(site) === key(entry)).length;
    const id = `${entry.file}:${key(entry)}`;
    const valid = productEnvFile(entry.file) && Number.isInteger(entry.reads) && entry.reads > 0 && !seen.has(id) && count >= entry.reads;
    seen.add(id);
    return valid ? [] : [`${productEnvBaselineFile}: stale or invalid ${id}; remove or lower the entry. Never increase allowances.`];
  });
}

export const productEnvRead: SourceRule = {
  name: 'product-env-read',
  description: 'Read product settings through core/product-env.ts; remaining shipped reads use a shrink-only inventory.',
  applies: productEnvFile,
  check: (file, source) => scanProductEnvReads(file, source).map(site => ({
    line: lineAt(source, site.offset),
    message: `${site.form} ${site.name}: use productEnv with a literal suffix or the dedicated home accessor. Never add an allowance to product-env-read.baseline.json (hearsay-tools/cezarion#2970).`,
  })),
};
