/**
 * SPEC-0051 G01 to G03: the public surface of the working tree as sets of tokens, and its
 * comparison with the committed baseline `schemas/compat-baseline.json`.
 *
 * Usage: node scripts/compat-baseline.mjs [--check] [--write] [--version X.Y.Z] [--root DIR]
 *   --check  compares the surface with the baseline and fails on a breaking change that nothing
 *            allows (the default);
 *   --write  writes the surface as the baseline of `--version` (default: package.json) after the
 *            same check, and empties `schemas/compat-accepted.json`.
 * Exits 1 on a breaking change and 2 on invalid arguments.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const CATEGORIES = Object.freeze([
  'exports',
  'types',
  'wire',
  'methods',
  'events',
  'errors',
  'reasons',
  'texts',
]);

/** G03: the fragments that hosts parse, each with the file that holds it. */
export const TEXTS = Object.freeze([
  ['packages/engine/src/index.ts', 'outcome_unknown: previous owner exited during a dispatch'],
  ['packages/engine/src/index.ts', 'Execution stop or local cleanup is unconfirmed'],
  ['packages/adapter-claude/src/index.ts', '; cleanup unconfirmed'],
  ['packages/adapter-codex/src/local.ts', ' supports '],
  ['packages/adapter-codex/src/local.ts', ' was requested'],
  ['packages/adapter-codex/src/index.ts', 'CODEX_EFFORT_UNSUPPORTED'],
  ['packages/adapter-codex/src/index.ts', 'CODEX_MODEL_UNLISTED'],
  ['packages/adapter-codex/src/index.ts', "is not among Codex's models"],
  ['packages/adapter-codex/src/index.ts', 'HOST_HOOK_BYPASSED'],
  ['packages/adapter-codex/src/index.ts', 'STOP_MARKER_BYPASSED'],
]);

const PACKAGES = ['engine', 'sdk-typescript', 'adapter-claude', 'adapter-codex', 'cli'];
// Input definitions and option types: a property that becomes required breaks existing callers.
const INPUT_DEFINITION = /(?:Params|Spec)$/;
const INPUT_TYPE = /(?:Options|Params|Spec|Config)$/;

const sorted = (set) => [...set].sort();
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** The literal strings an expression can take, and `head*` for a template. */
function literals(node, out = []) {
  if (!node) return out;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
  else if (ts.isTemplateExpression(node)) out.push(`${node.head.text}*`);
  else if (ts.isConditionalExpression(node)) {
    literals(node.whenTrue, out);
    literals(node.whenFalse, out);
  } else if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    if (
      kind === ts.SyntaxKind.QuestionQuestionToken ||
      kind === ts.SyntaxKind.BarBarToken ||
      kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      literals(node.left, out);
      literals(node.right, out);
    }
  } else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
    literals(node.expression, out);
  return out;
}

function sourceFiles(root, dirs) {
  const files = [];
  for (const dir of dirs) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort())
      if (name.endsWith('.ts') && !name.endsWith('.d.ts')) files.push(join(base, name));
  }
  return files;
}

function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

const calleeName = (call) =>
  ts.isIdentifier(call.expression)
    ? call.expression.text
    : ts.isPropertyAccessExpression(call.expression)
      ? call.expression.name.text
      : undefined;

/** exports and types: the package entries, read with the TypeScript compiler. */
function typescriptSurface(root, exportsOut, typesOut) {
  const entries = [];
  for (const dir of PACKAGES) {
    const pkg = readJson(join(root, 'packages', dir, 'package.json'));
    for (const [sub, file] of Object.entries(pkg.exports ?? {}))
      entries.push({
        name: sub === '.' ? pkg.name : `${pkg.name}/${sub.slice(2)}`,
        file: resolve(root, 'packages', dir, file),
      });
  }
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(root, 'tsconfig.json'),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  );
  const program = ts.createProgram(
    entries.map((entry) => entry.file),
    parsed.options,
  );
  const checker = program.getTypeChecker();
  const hidden = (symbol) => {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) return false;
    const flags = ts.getCombinedModifierFlags(declaration);
    return (
      (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0 ||
      symbol.getName().startsWith('#') ||
      symbol.getName().startsWith('__')
    );
  };
  const anonymous = (type) =>
    type.symbol &&
    (type.symbol.flags & (ts.SymbolFlags.TypeLiteral | ts.SymbolFlags.ObjectLiteral)) !== 0 &&
    type.getCallSignatures().length === 0;
  const members = (prefix, type, depth, seen) => {
    if (seen.has(type)) return;
    seen.add(type);
    if (type.isUnion()) {
      for (const part of type.types)
        if (part.isStringLiteral() || part.isNumberLiteral())
          typesOut.add(`${prefix} = ${JSON.stringify(part.value)}`);
        else if (part.flags & ts.TypeFlags.Object) members(prefix, part, depth, seen);
      return;
    }
    if (!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection))) return;
    for (const property of checker.getPropertiesOfType(type)) {
      if (hidden(property)) continue;
      const name = property.getName();
      const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
      typesOut.add(`${prefix}.${name}${optional ? '?' : ''}`);
      if (depth < 3) {
        const propertyType = checker.getTypeOfSymbol(property);
        const inner = checker.getNonNullableType(propertyType);
        if (anonymous(inner)) members(`${prefix}.${name}`, inner, depth + 1, seen);
      }
    }
  };
  for (const entry of entries) {
    exportsOut.add(entry.name);
    const source = program.getSourceFile(entry.file);
    const module = source && checker.getSymbolAtLocation(source);
    if (!module) continue;
    for (const exported of checker.getExportsOfModule(module)) {
      const symbol =
        exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const name = exported.getName();
      const prefix = `${entry.name} ${name}`;
      if (symbol.flags & ts.SymbolFlags.Value) exportsOut.add(`${entry.name} value ${name}`);
      if (symbol.flags & ts.SymbolFlags.Type) {
        exportsOut.add(`${entry.name} type ${name}`);
        members(prefix, checker.getDeclaredTypeOfSymbol(symbol), 0, new Set());
      }
      if (symbol.flags & ts.SymbolFlags.Class)
        for (const property of checker.getPropertiesOfType(checker.getTypeOfSymbol(symbol)))
          if (property.getName() !== 'prototype' && !hidden(property))
            typesOut.add(`${prefix}::${property.getName()}`);
    }
  }
}

/** exports of the Python package: its modules' public names and the client's namespaces. */
const PYTHON = String.raw`
import importlib, inspect, json, re, sys
tokens = set()
def own(value):
    return (getattr(value, "__module__", "") or "").startswith("orchvia")
def signature(prefix, value):
    try:
        parameters = inspect.signature(value).parameters.values()
    except (TypeError, ValueError):
        return
    for p in parameters:
        if p.name in ("self", "cls"):
            continue
        if p.kind is p.VAR_POSITIONAL:
            tokens.add(f"{prefix}(*{p.name})")
        elif p.kind is p.VAR_KEYWORD:
            tokens.add(f"{prefix}(**{p.name})")
        else:
            tokens.add(f"{prefix}({p.name}{'=' if p.default is not p.empty else ''})")
def members(prefix, cls, constructor=True):
    if constructor and "__init__" in vars(cls) or any("__init__" in vars(b) and own(b) for b in cls.__mro__[1:]):
        signature(prefix, cls)
    for name in getattr(cls, "__annotations__", {}):
        if not name.startswith("_"):
            tokens.add(f"{prefix}.{name}")
    for name in dir(cls):
        if name.startswith("_"):
            continue
        owner = next((b for b in cls.__mro__ if name in vars(b)), None)
        if owner is None or not own(owner):
            continue
        tokens.add(f"{prefix}.{name}")
        member = inspect.getattr_static(cls, name)
        if isinstance(member, (staticmethod, classmethod)) or inspect.isfunction(member):
            signature(f"{prefix}.{name}", getattr(cls, name))
for module_name in ("orchvia", "orchvia.routing"):
    module = importlib.import_module(module_name)
    names = getattr(module, "__all__", None)
    if names is None:
        names = [n for n in vars(module) if not n.startswith("_") and not inspect.ismodule(vars(module)[n])
                 and (own(vars(module)[n]) or not callable(vars(module)[n]))
                 and not (getattr(vars(module)[n], "__module__", "") or "").startswith("typing")]
    for name in sorted(names):
        value = getattr(module, name)
        tokens.add(f"{module_name} value {name}")
        if inspect.isclass(value) and own(value):
            members(f"{module_name}.{name}", value)
        elif inspect.isfunction(value):
            signature(f"{module_name}.{name}", value)
client = importlib.import_module("orchvia.client")
source = inspect.getsource(client.Orchestrator.__init__)
for attribute, cls in re.findall(r"self\.([a-z]\w*) = (\w+)\(self\)", source):
    members(f"orchvia.Orchestrator.{attribute}", getattr(client, cls), constructor=False)
print(json.dumps(sorted(tokens)))
`;

function pythonSurface(root, out) {
  const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const run = spawnSync(python, ['-c', PYTHON], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: join(root, 'python/src'), PYTHONDONTWRITEBYTECODE: '1' },
  });
  if (run.status !== 0) throw new Error(`The Python surface failed: ${run.stderr || run.error}`);
  for (const token of JSON.parse(run.stdout)) out.add(token);
}

/** wire: each definition flattened to property paths, required properties and values. */
function wireSurface(root, out) {
  const schema = readJson(join(root, 'schemas/protocol.schema.json'));
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (node.$ref) out.add(`${path} -> ${node.$ref.split('/').pop()}`);
    if ('const' in node) out.add(`${path} = ${JSON.stringify(node.const)}`);
    for (const value of node.enum ?? []) out.add(`${path} = ${JSON.stringify(value)}`);
    for (const type of [node.type ?? []].flat()) out.add(`${path} : ${type}`);
    for (const [name, child] of Object.entries(node.properties ?? {})) {
      out.add(`${path}.${name}`);
      walk(child, `${path}.${name}`);
    }
    for (const name of node.required ?? []) out.add(`${path}.${name}!`);
    if (node.items) walk(node.items, `${path}[]`);
    if (node.additionalProperties && typeof node.additionalProperties === 'object')
      walk(node.additionalProperties, `${path}{}`);
    for (const key of ['oneOf', 'anyOf', 'allOf'])
      for (const branch of node[key] ?? []) walk(branch, path);
    for (const key of ['then', 'else']) walk(node[key], path);
  };
  for (const [name, definition] of Object.entries(schema.$defs)) {
    out.add(name);
    walk(definition, name);
  }
  return schema;
}

/** methods, events, errors and reasons, from the sources. */
function sourceSurface(root, schema, out) {
  const parse = (file) =>
    ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const packageFiles = sourceFiles(
    root,
    PACKAGES.map((dir) => `packages/${dir}/src`),
  );
  for (const file of packageFiles) {
    const engine = file.startsWith(join(root, 'packages/engine/src'));
    visit(parse(file), (node) => {
      if (engine && ts.isSwitchStatement(node) && node.expression.getText() === 'method')
        for (const clause of node.caseBlock.clauses)
          if (ts.isCaseClause(clause))
            for (const value of literals(clause.expression)) out.methods.add(value);
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const name = ts.isCallExpression(node)
          ? calleeName(node)
          : node.expression.getText().split('.').pop();
        const [first, , third] = node.arguments ?? [];
        if (ts.isCallExpression(node) && name === 'event')
          for (const value of literals(first)) if (!value.endsWith('*')) out.events.add(value);
        if (name === 'fail' || name === 'coded' || name?.endsWith('Error'))
          for (const value of literals(first))
            if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(value)) out.errors.add(value);
        if (engine && name === 'saveTask')
          for (const value of literals(third)) if (value !== '*') out.reasons.add(value);
      }
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText() === 'code' &&
        ts.isStringLiteral(node.initializer) &&
        /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(node.initializer.text)
      )
        out.errors.add(node.initializer.text);
      if (
        engine &&
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        node.left.getText() === 'task.reason'
      )
        for (const value of literals(node.right)) out.reasons.add(value);
    });
  }
  for (const status of schema.$defs.TaskStatus.enum) out.events.add(`task.${status}`);
  for (const file of readdirSync(join(root, 'python/src/orchvia')).sort())
    if (file.endsWith('.py'))
      for (const match of readFileSync(join(root, 'python/src/orchvia', file), 'utf8').matchAll(
        /(?:Error|fail)\(\s*["']([A-Z][A-Z0-9]*_[A-Z0-9_]+)["']/g,
      ))
        out.errors.add(match[1]);
}

/** texts: each fragment of TEXTS while its file holds it (G03). */
export function textSurface(root) {
  const out = new Set();
  for (const [file, text] of TEXTS) {
    const path = join(root, file);
    if (existsSync(path) && readFileSync(path, 'utf8').includes(text)) out.add(`${file}: ${text}`);
  }
  return sorted(out);
}

export async function buildSurface(root) {
  const out = Object.fromEntries(CATEGORIES.map((category) => [category, new Set()]));
  typescriptSurface(root, out.exports, out.types);
  pythonSurface(root, out.exports);
  const schema = wireSurface(root, out.wire);
  sourceSurface(root, schema, out);
  out.texts = new Set(textSurface(root));
  return Object.fromEntries(CATEGORIES.map((category) => [category, sorted(out[category])]));
}

const minor = (version) => version.split(/[.-]/).slice(0, 2).map(Number);
const higherMinor = (version, than) => {
  const [a, b] = minor(version);
  const [c, d] = minor(than);
  return a > c || (a === c && b > d);
};

/**
 * G02: compares a baseline `{version, surface}` with a surface. A token of the baseline that is gone
 * is breaking, and so is a newly required input: a required property of a `*Params` or `*Spec`
 * definition, a required member of an option type, or a required Python parameter, where the
 * definition, type or function was already there.
 */
export function compareSurface(baseline, surface, { version, accepted }) {
  const removed = [];
  const added = [];
  const breaking = [];
  for (const category of Object.keys({ ...baseline.surface, ...surface }).sort()) {
    const before = new Set(baseline.surface[category] ?? []);
    const after = new Set(surface[category] ?? []);
    const had = (prefix) => [...before].some((token) => token.startsWith(prefix));
    for (const token of sorted(before))
      if (!after.has(token)) {
        removed.push(`${category}: ${token}`);
        breaking.push({ category, token, kind: 'removed' });
      }
    for (const token of sorted(after)) {
      if (before.has(token)) continue;
      added.push(`${category}: ${token}`);
      let required = false;
      if (category === 'wire') {
        const match = /^(\w+)((?:\.[\w$-]+|\[\]|\{\})*)\.[\w$-]+!$/.exec(token);
        if (match && INPUT_DEFINITION.test(match[1]))
          required = match[2] ? before.has(`${match[1]}${match[2]}`) : had(`${match[1]}.`);
      } else if (category === 'types') {
        const match = /^(\S+ (\w+))\.\w+$/.exec(token);
        if (match && INPUT_TYPE.test(match[2])) required = had(`${match[1]}.`);
      } else if (category === 'exports') {
        const match = /^(\S+)\(\w+\)$/.exec(token);
        if (match) required = before.has(match[1]);
      }
      if (required) breaking.push({ category, token, kind: 'newly required' });
    }
  }
  // A patch release cannot declare a breaking change (SPEC-0044 S02), so only a minor can.
  const allowedBy = higherMinor(version, baseline.version) ? 'minor' : undefined;
  const unaccepted = breaking
    .filter(
      ({ category, token }) =>
        !accepted.some((entry) => entry.category === category && entry.token === token),
    )
    .map(({ category, token, kind }) => `${category}: ${token} (${kind})`)
    .sort();
  return {
    added,
    removed,
    breaking,
    allowedBy,
    unaccepted: allowedBy ? [] : unaccepted,
    ok: allowedBy !== undefined || unaccepted.length === 0,
  };
}

/** Checks the working tree against the baseline, and with `write` replaces the baseline. */
export async function checkBaseline(root, { version, write = false }) {
  const baselinePath = join(root, 'schemas/compat-baseline.json');
  const acceptedPath = join(root, 'schemas/compat-accepted.json');
  const surface = await buildSurface(root);
  const baseline = existsSync(baselinePath) ? readJson(baselinePath) : undefined;
  const result = baseline
    ? compareSurface(baseline, surface, {
        version,
        accepted: existsSync(acceptedPath) ? readJson(acceptedPath).accepted : [],
      })
    : { ok: true, added: [], unaccepted: [], allowedBy: 'no baseline' };
  if (result.ok && write) {
    // Written as the formatting check expects it.
    const { default: prettier } = await import('prettier');
    const json = async (path, value) =>
      writeFileSync(
        path,
        await prettier.format(JSON.stringify(value), {
          ...(await prettier.resolveConfig(path)),
          filepath: path,
        }),
      );
    await json(baselinePath, { version, surface });
    await json(acceptedPath, { accepted: [] });
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? undefined : args[at + 1];
  };
  const root = resolve(option('root') ?? join(fileURLToPath(import.meta.url), '../..'));
  const version = option('version') ?? readJson(join(root, 'package.json')).version;
  const write = args.includes('--write');
  const result = await checkBaseline(root, { version, write });
  for (const line of result.added) console.log(`added   ${line}`);
  if (!result.ok) {
    for (const line of result.unaccepted) console.error(`BREAKING ${line}`);
    console.error(
      'A breaking change needs a higher minor version, or an entry with a reason in ' +
        'schemas/compat-accepted.json when the change breaks nothing.',
    );
    process.exit(1);
  }
  if (result.allowedBy === 'minor')
    for (const item of result.breaking)
      console.log(`allowed ${item.category}: ${item.token} (${item.kind}; ${result.allowedBy})`);
  if (write) console.log(`schemas/compat-baseline.json is the surface of ${version}`);
}
