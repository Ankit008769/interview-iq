import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { ProjectFile } from './ingest.js';

// Symbol index for an uploaded project (roadmap C4): functions, classes, methods and components from
// tree-sitter syntax trees (the WebAssembly build VS Code ships, so no native modules), web routes from the
// common frameworks, and dependencies from manifest files. Embedding search is not used yet: questions pick
// symbols directly, and resume claims are matched lexically.
const require = createRequire(import.meta.url);
type TS = typeof import('@vscode/tree-sitter-wasm');
export type SymbolKind = 'function' | 'method' | 'class' | 'component' | 'route';
export type CodeSymbol = { name: string; kind: SymbolKind; path: string; line: number; endLine: number };
export type Dependency = { name: string; version?: string; source: string };

const GRAMMARS: Record<string, string> = { javascript: 'javascript', typescript: 'typescript', tsx: 'tsx', python: 'python', java: 'java',
  go: 'go', rust: 'rust', ruby: 'ruby', php: 'php', csharp: 'c-sharp', cpp: 'cpp', c: 'cpp' };
// One query per grammar; capture names give the symbol kind.
const QUERIES: Record<string, string> = {
  javascript: `(function_declaration name: (identifier) @function) (class_declaration name: (identifier) @class)
    (method_definition name: (property_identifier) @method)
    (variable_declarator name: (identifier) @function value: [(arrow_function) (function_expression)])`,
  typescript: `(function_declaration name: (identifier) @function) (class_declaration name: (type_identifier) @class)
    (abstract_class_declaration name: (type_identifier) @class) (method_definition name: (property_identifier) @method)
    (variable_declarator name: (identifier) @function value: [(arrow_function) (function_expression)])`,
  python: `(function_definition name: (identifier) @function) (class_definition name: (identifier) @class)`,
  java: `(class_declaration name: (identifier) @class) (interface_declaration name: (identifier) @class)
    (method_declaration name: (identifier) @method) (constructor_declaration name: (identifier) @method)`,
  go: `(function_declaration name: (identifier) @function) (method_declaration name: (field_identifier) @method)
    (type_declaration (type_spec name: (type_identifier) @class))`,
  rust: `(function_item name: (identifier) @function) (struct_item name: (type_identifier) @class) (impl_item type: (type_identifier) @class)`,
  ruby: `(method name: (identifier) @method) (class name: (constant) @class) (module name: (constant) @class)`,
  php: `(function_definition name: (name) @function) (class_declaration name: (name) @class) (method_declaration name: (name) @method)`,
  'c-sharp': `(class_declaration name: (identifier) @class) (method_declaration name: (identifier) @method) (interface_declaration name: (identifier) @class)`,
  cpp: `(function_definition declarator: (function_declarator declarator: [(identifier) (field_identifier) (qualified_identifier)] @function))
    (class_specifier name: (type_identifier) @class) (struct_specifier name: (type_identifier) @class)`,
};
QUERIES.tsx = QUERIES.typescript;

let runtime: Promise<{ ts: TS; dir: string }> | undefined;
const languages = new Map<string, Promise<{ language: InstanceType<TS['Language']>; query: InstanceType<TS['Query']> } | null>>();
function loadRuntime() {
  runtime ??= (async () => {
    const ts = require('@vscode/tree-sitter-wasm') as TS;
    const dir = dirname(require.resolve('@vscode/tree-sitter-wasm'));
    await ts.Parser.init({ locateFile: (file: string) => join(dir, file) });
    return { ts, dir };
  })();
  return runtime;
}
function grammar(name: string) {
  let loaded = languages.get(name);
  if (!loaded) {
    loaded = (async () => {
      const { ts, dir } = await loadRuntime();
      try {
        const language = await ts.Language.load(join(dir, `tree-sitter-${name}.wasm`));
        return { language, query: new ts.Query(language, QUERIES[name]) };
      } catch { return null; }
    })();
    languages.set(name, loaded);
  }
  return loaded;
}

const isComponentFile = (path: string) => /\.(jsx|tsx)$/.test(path);
const ROUTES = [
  /\b(?:app|router|server|api|route)\.(get|post|put|patch|delete|all)\(\s*['"`]([^'"`]{1,120})['"`]/g, // Express, Koa, Fastify
  /@(?:app|bp|blueprint|router|api)\.(get|post|put|patch|delete|route)\(\s*['"]([^'"]{1,120})['"]/g, // Flask, FastAPI
  /@(Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]{1,120})"/g, // Spring
  /\b(?:path|re_path)\(\s*r?['"]([^'"]{0,120})['"]/g, // Django
];

async function symbolsFor(file: ProjectFile): Promise<CodeSymbol[]> {
  const found: CodeSymbol[] = [];
  const name = GRAMMARS[file.language];
  const loaded = name ? await grammar(name) : null;
  if (loaded) {
    const { ts } = await loadRuntime();
    const parser = new ts.Parser();
    parser.setLanguage(loaded.language);
    const tree = parser.parse(file.text);
    if (tree) {
      for (const capture of loaded.query.captures(tree.rootNode)) {
        // The symbol spans its whole definition, which is the captured name's parent (or grandparent).
        let definition = capture.node.parent ?? capture.node;
        if (definition.type === 'variable_declarator' && definition.parent) definition = definition.parent;
        if (definition.type === 'function_declarator' && definition.parent) definition = definition.parent;
        // A function defined inside a class body is a method (Python has no separate node for one).
        const inClass = [definition.parent, definition.parent?.parent].some(n => n && /^(class_definition|class_body|class_declaration)$/.test(n.type));
        const kind = capture.name === 'class' ? 'class'
          : capture.name === 'function' && inClass ? 'method'
          : (capture.name === 'function' && isComponentFile(file.path) && /^[A-Z]/.test(capture.node.text)) ? 'component' : capture.name as SymbolKind;
        found.push({ name: capture.node.text.slice(0, 120), kind, path: file.path, line: definition.startPosition.row + 1, endLine: definition.endPosition.row + 1 });
      }
      tree.delete();
    }
    parser.delete();
  }
  for (const pattern of ROUTES) {
    for (const m of file.text.matchAll(pattern)) {
      const [method, route] = m.length > 2 && m[2] !== undefined ? [m[1], m[2]] : ['path', m[1]];
      const line = file.text.slice(0, m.index).split('\n').length;
      found.push({ name: `${method.toUpperCase()} ${route}`, kind: 'route', path: file.path, line, endLine: line });
    }
  }
  const seen = new Set<string>();
  return found.filter(s => { const key = `${s.kind}:${s.name}:${s.line}`; return !seen.has(key) && Boolean(seen.add(key)); }).slice(0, 200);
}

export async function indexSymbols(files: ProjectFile[]): Promise<CodeSymbol[]> {
  const symbols: CodeSymbol[] = [];
  for (const file of files) {
    if (symbols.length >= 3000) break;
    symbols.push(...await symbolsFor(file));
  }
  return symbols.slice(0, 3000);
}

const add = (list: Dependency[], name: string, version: string | undefined, source: string) => {
  const clean = name.trim();
  if (clean && clean.length <= 100 && !list.some(d => d.name.toLowerCase() === clean.toLowerCase())) list.push({ name: clean, ...(version ? { version: version.trim().slice(0, 40) } : {}), source });
};
export function findDependencies(files: ProjectFile[]): Dependency[] {
  const deps: Dependency[] = [];
  for (const file of files) {
    const name = file.path.split('/').at(-1)!.toLowerCase();
    try {
      if (name === 'package.json') {
        const pkg = JSON.parse(file.text);
        for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) for (const [n, v] of Object.entries(pkg[field] ?? {})) add(deps, n, String(v), file.path);
      } else if (name === 'requirements.txt' || name.endsWith('-requirements.txt')) {
        for (const line of file.text.split('\n')) { const m = line.match(/^\s*([A-Za-z0-9_.\-[\]]+)\s*([=<>!~]=?\s*[^\s;#]+)?/); if (m && !line.trim().startsWith('#') && !line.trim().startsWith('-')) add(deps, m[1].replace(/\[.*\]/, ''), m[2], file.path); }
      } else if (name === 'pyproject.toml') {
        for (const m of file.text.matchAll(/^\s*"([A-Za-z0-9_.-]+)\s*([<>=!~][^"]*)?"/gm)) add(deps, m[1], m[2], file.path);
      } else if (name === 'pom.xml') {
        for (const m of file.text.matchAll(/<artifactId>([^<]+)<\/artifactId>(?:\s*<version>([^<]+)<\/version>)?/g)) add(deps, m[1], m[2], file.path);
      } else if (name === 'build.gradle' || name === 'build.gradle.kts') {
        for (const m of file.text.matchAll(/(?:implementation|api|compileOnly|runtimeOnly|testImplementation)\s*\(?\s*['"]([^:'"]+):([^:'"]+)(?::([^'"]+))?['"]/g)) add(deps, m[2], m[3], file.path);
      } else if (name === 'go.mod') {
        for (const m of file.text.matchAll(/^\s*(?:require\s+)?([a-z0-9.\-]+\.[a-z]{2,}\/[^\s]+)\s+(v[^\s]+)/gm)) add(deps, m[1], m[2], file.path);
      } else if (name === 'cargo.toml') {
        const section = file.text.split(/^\[dependencies\]\s*$/m)[1]?.split(/^\[/m)[0] ?? '';
        for (const m of section.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/gm)) add(deps, m[1], m[2] ?? m[3], file.path);
      } else if (name === 'gemfile') {
        for (const m of file.text.matchAll(/^\s*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/gm)) add(deps, m[1], m[2], file.path);
      } else if (name === 'composer.json') {
        const pkg = JSON.parse(file.text);
        for (const [n, v] of Object.entries(pkg.require ?? {})) add(deps, n, String(v), file.path);
      }
    } catch { /* a malformed manifest adds nothing */ }
  }
  return deps.slice(0, 500);
}
