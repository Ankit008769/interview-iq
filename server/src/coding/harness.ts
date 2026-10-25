import type { CodeLanguage, FunctionProblem, Signature, SqlProblem, ValueType } from './types.js';

// Each program is the candidate's code followed by a harness that reads one JSON argument list per line,
// calls the candidate's function and prints one tagged JSON result per test. Expected answers never leave
// the app: the harness only reports what the code returned, and grading happens here.
export const marker = (nonce: string) => `@@IQ:${nonce}:`;
export const snake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const JAVA_PRELUDE = 'import java.util.*;\nimport java.util.stream.*;\n';
const CPP_PRELUDE = '#include <bits/stdc++.h>\nusing namespace std;\n';
// Lines added before the candidate's code, so error messages can point at the candidate's own line numbers.
export const PRELUDE_LINES: Record<CodeLanguage | 'sql', number> = { javascript: 0, typescript: 0, python: 0, java: 2, cpp: 2, sql: 0 };

const TS: Record<ValueType, string> = { int: 'number', long: 'number', double: 'number', bool: 'boolean', string: 'string',
  'int[]': 'number[]', 'double[]': 'number[]', 'string[]': 'string[]', 'int[][]': 'number[][]', 'string[][]': 'string[][]' };
const PY: Record<ValueType, string> = { int: 'int', long: 'int', double: 'float', bool: 'bool', string: 'str',
  'int[]': 'list[int]', 'double[]': 'list[float]', 'string[]': 'list[str]', 'int[][]': 'list[list[int]]', 'string[][]': 'list[list[str]]' };
const JAVA: Record<ValueType, string> = { int: 'int', long: 'long', double: 'double', bool: 'boolean', string: 'String',
  'int[]': 'int[]', 'double[]': 'double[]', 'string[]': 'String[]', 'int[][]': 'int[][]', 'string[][]': 'List<List<String>>' };
const CPP: Record<ValueType, string> = { int: 'int', long: 'long long', double: 'double', bool: 'bool', string: 'string',
  'int[]': 'vector<int>', 'double[]': 'vector<double>', 'string[]': 'vector<string>', 'int[][]': 'vector<vector<int>>', 'string[][]': 'vector<vector<string>>' };
const JAVA_FROM: Record<ValueType, string> = { int: 'i', long: 'l', double: 'd', bool: 'b', string: 's',
  'int[]': 'ints', 'double[]': 'doubles', 'string[]': 'strs', 'int[][]': 'intss', 'string[][]': 'strss' };
const JSDOC: Record<ValueType, string> = { ...TS };
const cppParam = (type: ValueType, name: string) => (type.endsWith(']') || type === 'string' ? `${CPP[type]}& ${name}` : `${CPP[type]} ${name}`);

export function starterCode(problem: FunctionProblem, language: CodeLanguage): string {
  if (problem.starter?.[language]) return problem.starter[language]!;
  const { name, params, returns } = problem.signature;
  const body = 'Write your solution here';
  switch (language) {
    case 'javascript':
      return `/**\n${params.map(p => ` * @param {${JSDOC[p.type]}} ${p.name}\n`).join('')} * @return {${JSDOC[returns]}}\n */\nfunction ${name}(${params.map(p => p.name).join(', ')}) {\n  // ${body}\n}\n`;
    case 'typescript':
      return `function ${name}(${params.map(p => `${p.name}: ${TS[p.type]}`).join(', ')}): ${TS[returns]} {\n  // ${body}\n}\n`;
    case 'python':
      return `def ${snake(name)}(${params.map(p => `${snake(p.name)}: ${PY[p.type]}`).join(', ')}) -> ${PY[returns]}:\n    # ${body}\n    pass\n`;
    case 'java':
      return `class Solution {\n    public ${JAVA[returns]} ${name}(${params.map(p => `${JAVA[p.type]} ${p.name}`).join(', ')}) {\n        // ${body}\n    }\n}\n`;
    case 'cpp':
      return `class Solution {\npublic:\n    ${CPP[returns]} ${name}(${params.map(p => cppParam(p.type, p.name)).join(', ')}) {\n        // ${body}\n    }\n};\n`;
  }
}

function jsHarness(signature: Signature, tag: string) {
  const { name } = signature;
  return `
;(function () {
  const fs = globalThis.process.getBuiltinModule('node:fs');
  const tag = ${JSON.stringify(tag)};
  const emit = record => fs.writeSync(1, tag + JSON.stringify(record) + '\\n');
  const fn = typeof ${name} === 'function' ? ${name}
    : typeof Solution === 'function' ? (...args) => new Solution().${name}(...args) : null;
  if (!fn) { emit({ i: -1, ok: false, error: 'Define a function named ${name}.' }); return; }
  let i = 0;
  for (const raw of fs.readFileSync(0, 'utf8').split('\\n')) {
    const line = raw.trim();
    if (!line) continue;
    const args = JSON.parse(line);
    const started = performance.now();
    let record;
    try {
      const value = fn(...args);
      record = tag + JSON.stringify({ i, ok: true, ms: performance.now() - started, v: value === undefined ? null : value }) + '\\n';
    } catch (e) {
      record = tag + JSON.stringify({ i, ok: false, ms: performance.now() - started, error: String(e && e.name ? e.name + ': ' + e.message : e).slice(0, 300) }) + '\\n';
    }
    fs.writeSync(1, record);
    i++;
  }
})();
`;
}

function pythonHarness(signature: Signature, tag: string) {
  const name = snake(signature.name);
  return `

def __iq_main():
    import sys, json, time
    tag = ${JSON.stringify(tag)}
    scope = globals()
    fn = scope.get(${JSON.stringify(name)}) or scope.get(${JSON.stringify(signature.name)})
    if fn is None and 'Solution' in scope:
        solution = scope['Solution']
        method = ${JSON.stringify(name)} if hasattr(solution, ${JSON.stringify(name)}) else ${JSON.stringify(signature.name)}
        fn = lambda *args: getattr(solution(), method)(*args)
    if fn is None:
        print(tag + json.dumps({'i': -1, 'ok': False, 'error': 'Define a function named ${name}.'}), flush=True)
        return
    sys.setrecursionlimit(20000)
    convert = lambda v: sorted(v) if isinstance(v, (set, frozenset)) else list(v) if isinstance(v, tuple) else str(v)
    i = 0
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        args = json.loads(line)
        started = time.perf_counter()
        try:
            value = fn(*args)
            record = json.dumps({'i': i, 'ok': True, 'ms': (time.perf_counter() - started) * 1000, 'v': value}, default=convert)
        except Exception as e:
            record = json.dumps({'i': i, 'ok': False, 'ms': (time.perf_counter() - started) * 1000, 'error': (type(e).__name__ + ': ' + str(e))[:300]})
        print(tag + record, flush=True)
        i += 1

__iq_main()
`;
}

function javaHarness(signature: Signature, tag: string) {
  const call = `new Solution().${signature.name}(${signature.params.map((p, i) => `IQ.${JAVA_FROM[p.type]}(args.get(${i}))`).join(', ')})`;
  return `
public class Main {
  public static void main(String[] argv) throws Exception {
    java.io.BufferedReader in = new java.io.BufferedReader(new java.io.InputStreamReader(System.in, java.nio.charset.StandardCharsets.UTF_8));
    String tag = ${JSON.stringify(tag)};
    String line; int i = 0;
    while ((line = in.readLine()) != null) {
      line = line.trim();
      if (line.isEmpty()) continue;
      List<?> args = (List<?>) new IQ.Parser(line).value();
      long started = System.nanoTime();
      String record;
      try {
        Object value = ${call};
        record = "{\\"i\\":" + i + ",\\"ok\\":true,\\"ms\\":" + ((System.nanoTime() - started) / 1e6) + ",\\"v\\":" + IQ.json(value) + "}";
      } catch (Throwable e) {
        record = "{\\"i\\":" + i + ",\\"ok\\":false,\\"ms\\":" + ((System.nanoTime() - started) / 1e6) + ",\\"error\\":" + IQ.quote(String.valueOf(e)) + "}";
      }
      System.out.println(tag + record);
      System.out.flush();
      i++;
    }
  }
}

final class IQ {
  static int i(Object o) { return ((Number) o).intValue(); }
  static long l(Object o) { return ((Number) o).longValue(); }
  static double d(Object o) { return ((Number) o).doubleValue(); }
  static boolean b(Object o) { return (Boolean) o; }
  static String s(Object o) { return (String) o; }
  static int[] ints(Object o) { List<?> x = (List<?>) o; int[] r = new int[x.size()]; for (int k = 0; k < r.length; k++) r[k] = i(x.get(k)); return r; }
  static double[] doubles(Object o) { List<?> x = (List<?>) o; double[] r = new double[x.size()]; for (int k = 0; k < r.length; k++) r[k] = d(x.get(k)); return r; }
  static String[] strs(Object o) { List<?> x = (List<?>) o; String[] r = new String[x.size()]; for (int k = 0; k < r.length; k++) r[k] = s(x.get(k)); return r; }
  static int[][] intss(Object o) { List<?> x = (List<?>) o; int[][] r = new int[x.size()][]; for (int k = 0; k < r.length; k++) r[k] = ints(x.get(k)); return r; }
  static List<List<String>> strss(Object o) { List<List<String>> r = new ArrayList<>(); for (Object row : (List<?>) o) r.add(new ArrayList<>(Arrays.asList(strs(row)))); return r; }
  static String quote(String s) {
    StringBuilder b = new StringBuilder("\\"");
    for (char c : s.toCharArray()) {
      if (c == '"' || c == '\\\\') b.append('\\\\').append(c);
      else if (c < 0x20) b.append(String.format("\\\\u%04x", (int) c));
      else b.append(c);
    }
    return b.append('"').toString();
  }
  static String json(Object v) { StringBuilder b = new StringBuilder(); write(b, v); return b.toString(); }
  static void write(StringBuilder b, Object v) {
    if (v == null) b.append("null");
    else if (v instanceof Boolean || v instanceof Integer || v instanceof Long || v instanceof Short || v instanceof Byte) b.append(v);
    else if (v instanceof Double || v instanceof Float) { double d = ((Number) v).doubleValue(); b.append(Double.isFinite(d) ? Double.toString(d) : "null"); }
    else if (v instanceof Character || v instanceof String) b.append(quote(v.toString()));
    else if (v instanceof int[]) { int[] a = (int[]) v; b.append('['); for (int k = 0; k < a.length; k++) { if (k > 0) b.append(','); b.append(a[k]); } b.append(']'); }
    else if (v instanceof long[]) { long[] a = (long[]) v; b.append('['); for (int k = 0; k < a.length; k++) { if (k > 0) b.append(','); b.append(a[k]); } b.append(']'); }
    else if (v instanceof double[]) { double[] a = (double[]) v; b.append('['); for (int k = 0; k < a.length; k++) { if (k > 0) b.append(','); write(b, a[k]); } b.append(']'); }
    else if (v instanceof boolean[]) { boolean[] a = (boolean[]) v; b.append('['); for (int k = 0; k < a.length; k++) { if (k > 0) b.append(','); b.append(a[k]); } b.append(']'); }
    else if (v instanceof char[]) b.append(quote(new String((char[]) v)));
    else if (v instanceof Object[]) { Object[] a = (Object[]) v; b.append('['); for (int k = 0; k < a.length; k++) { if (k > 0) b.append(','); write(b, a[k]); } b.append(']'); }
    else if (v instanceof Iterable) { b.append('['); boolean first = true; for (Object x : (Iterable<?>) v) { if (!first) b.append(','); first = false; write(b, x); } b.append(']'); }
    else b.append(quote(v.toString()));
  }
  static final class Parser {
    private final String s; private int p = 0;
    Parser(String s) { this.s = s; }
    private void ws() { while (p < s.length() && Character.isWhitespace(s.charAt(p))) p++; }
    Object value() {
      ws();
      char c = s.charAt(p);
      if (c == '[') { p++; List<Object> list = new ArrayList<>(); ws(); if (s.charAt(p) == ']') { p++; return list; }
        while (true) { list.add(value()); ws(); if (s.charAt(p) == ',') { p++; continue; } p++; return list; } }
      if (c == '"') return string();
      if (s.startsWith("true", p)) { p += 4; return Boolean.TRUE; }
      if (s.startsWith("false", p)) { p += 5; return Boolean.FALSE; }
      if (s.startsWith("null", p)) { p += 4; return null; }
      int start = p; boolean real = false;
      while (p < s.length() && "+-0123456789.eE".indexOf(s.charAt(p)) >= 0) { if ("eE.".indexOf(s.charAt(p)) >= 0) real = true; p++; }
      String n = s.substring(start, p);
      return real ? (Object) Double.parseDouble(n) : (Object) Long.parseLong(n);
    }
    private String string() {
      StringBuilder b = new StringBuilder(); p++;
      while (true) {
        char c = s.charAt(p++);
        if (c == '"') return b.toString();
        if (c != '\\\\') { b.append(c); continue; }
        char e = s.charAt(p++);
        switch (e) {
          case 'n': b.append('\\n'); break; case 't': b.append('\\t'); break; case 'r': b.append('\\r'); break;
          case 'b': b.append('\\b'); break; case 'f': b.append('\\f'); break;
          case 'u': b.append((char) Integer.parseInt(s.substring(p, p + 4), 16)); p += 4; break;
          default: b.append(e);
        }
      }
    }
  }
}
`;
}

function cppHarness(signature: Signature, tag: string) {
  const reads = signature.params.map((p, i) => `      auto a${i} = iq::get<${CPP[p.type]}>(args.a.at(${i}));`).join('\n');
  return `
namespace iq {
struct J { int t = 0; bool b = false; double n = 0; long long i = 0; std::string s; std::vector<J> a; };
struct Parser {
  const std::string& x; size_t p = 0;
  explicit Parser(const std::string& x) : x(x) {}
  void ws() { while (p < x.size() && isspace((unsigned char)x[p])) p++; }
  J value() {
    ws(); J j;
    char c = x.at(p);
    if (c == '[') { p++; j.t = 4; ws(); if (x.at(p) == ']') { p++; return j; }
      while (true) { j.a.push_back(value()); ws(); if (x.at(p) == ',') { p++; continue; } p++; return j; } }
    if (c == '"') { j.t = 3; j.s = str(); return j; }
    if (x.compare(p, 4, "true") == 0) { p += 4; j.t = 1; j.b = true; return j; }
    if (x.compare(p, 5, "false") == 0) { p += 5; j.t = 1; return j; }
    if (x.compare(p, 4, "null") == 0) { p += 4; return j; }
    size_t start = p;
    while (p < x.size() && std::string("+-0123456789.eE").find(x[p]) != std::string::npos) p++;
    std::string n = x.substr(start, p - start);
    j.t = 2; j.n = std::strtod(n.c_str(), nullptr); j.i = std::strtoll(n.c_str(), nullptr, 10);
    return j;
  }
  std::string str() {
    std::string out; p++;
    while (true) {
      char c = x.at(p++);
      if (c == '"') return out;
      if (c != '\\\\') { out += c; continue; }
      char e = x.at(p++);
      if (e == 'n') out += '\\n'; else if (e == 't') out += '\\t'; else if (e == 'r') out += '\\r';
      else if (e == 'b') out += '\\b'; else if (e == 'f') out += '\\f';
      else if (e == 'u') {
        unsigned code = std::stoul(x.substr(p, 4), nullptr, 16); p += 4;
        if (code < 0x80) out += (char)code;
        else if (code < 0x800) { out += (char)(0xC0 | (code >> 6)); out += (char)(0x80 | (code & 0x3F)); }
        else { out += (char)(0xE0 | (code >> 12)); out += (char)(0x80 | ((code >> 6) & 0x3F)); out += (char)(0x80 | (code & 0x3F)); }
      } else out += e;
    }
  }
};
inline void from(const J& j, int& v) { v = (int)j.i; }
inline void from(const J& j, long long& v) { v = j.i; }
inline void from(const J& j, double& v) { v = j.n; }
inline void from(const J& j, bool& v) { v = j.b; }
inline void from(const J& j, std::string& v) { v = j.s; }
template <class T> void from(const J& j, std::vector<T>& v) { v.resize(j.a.size()); for (size_t k = 0; k < j.a.size(); k++) from(j.a[k], v[k]); }
template <class T> T get(const J& j) { T v{}; from(j, v); return v; }
inline void to(std::string& o, int v) { o += std::to_string(v); }
inline void to(std::string& o, long v) { o += std::to_string(v); }
inline void to(std::string& o, long long v) { o += std::to_string(v); }
inline void to(std::string& o, unsigned v) { o += std::to_string(v); }
inline void to(std::string& o, unsigned long v) { o += std::to_string(v); }
inline void to(std::string& o, unsigned long long v) { o += std::to_string(v); }
inline void to(std::string& o, bool v) { o += v ? "true" : "false"; }
inline void to(std::string& o, double v) { if (!std::isfinite(v)) { o += "null"; return; } char buf[40]; std::snprintf(buf, sizeof buf, "%.17g", v); o += buf; }
inline void to(std::string& o, float v) { to(o, (double)v); }
inline void to(std::string& o, const std::string& v) {
  o += '"';
  for (unsigned char c : v) { if (c == '"' || c == '\\\\') { o += '\\\\'; o += (char)c; } else if (c < 0x20) { char buf[8]; std::snprintf(buf, sizeof buf, "\\\\u%04x", c); o += buf; } else o += (char)c; }
  o += '"';
}
inline void to(std::string& o, const char* v) { to(o, std::string(v)); }
inline void to(std::string& o, char v) { to(o, std::string(1, v)); }
template <class T> void to(std::string& o, const std::vector<T>& v) { o += '['; for (size_t k = 0; k < v.size(); k++) { if (k) o += ','; to(o, static_cast<const T&>(v[k])); } o += ']'; }
inline std::string quote(const std::string& s) { std::string o; to(o, s); return o; }
}

int main() {
  // Unsynchronized streams read the large test lines quickly; each result line is still written whole.
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);
  const std::string tag = ${JSON.stringify(tag)};
  std::string line; int i = 0;
  while (std::getline(std::cin, line)) {
    if (line.find_first_not_of(" \\t\\r") == std::string::npos) continue;
    iq::J args = iq::Parser(line).value();
    auto started = std::chrono::steady_clock::now();
    auto elapsed = [&] { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count(); };
    std::string record;
    try {
${reads}
      auto value = Solution().${signature.name}(${signature.params.map((_, i) => `a${i}`).join(', ')});
      std::string out; iq::to(out, value);
      record = "{\\"i\\":" + std::to_string(i) + ",\\"ok\\":true,\\"ms\\":" + std::to_string(elapsed()) + ",\\"v\\":" + out + "}";
    } catch (const std::exception& e) {
      record = "{\\"i\\":" + std::to_string(i) + ",\\"ok\\":false,\\"ms\\":" + std::to_string(elapsed()) + ",\\"error\\":" + iq::quote(e.what()) + "}";
    } catch (...) {
      record = "{\\"i\\":" + std::to_string(i) + ",\\"ok\\":false,\\"ms\\":" + std::to_string(elapsed()) + ",\\"error\\":\\"unknown exception\\"}";
    }
    std::cout << tag << record << std::endl;
    i++;
  }
  return 0;
}
`;
}

function sqlHarness(problem: SqlProblem, query: string, tag: string) {
  return `import json, sqlite3, sys, time

TAG = ${JSON.stringify(tag)}
SCHEMA = ${JSON.stringify(problem.schema)}
QUERY = ${JSON.stringify(query)}

def main():
    i = 0
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        seed = json.loads(line)[0]
        started = time.perf_counter()
        try:
            db = sqlite3.connect(':memory:')
            db.executescript(SCHEMA)
            db.executescript(seed)
            cursor = db.execute(QUERY.strip().rstrip(';').strip())
            rows = [list(row) for row in cursor.fetchmany(1001)]
            columns = [d[0] for d in (cursor.description or [])]
            record = {'i': i, 'ok': True, 'ms': (time.perf_counter() - started) * 1000, 'v': rows, 'columns': columns}
        except Exception as e:
            record = {'i': i, 'ok': False, 'ms': (time.perf_counter() - started) * 1000, 'error': (type(e).__name__ + ': ' + str(e))[:300]}
        print(TAG + json.dumps(record, default=str), flush=True)
        i += 1

main()
`;
}

export function buildProgram(problem: FunctionProblem | SqlProblem, language: CodeLanguage | 'sql', source: string, nonce: string): { language: CodeLanguage; source: string } {
  const tag = marker(nonce);
  if (problem.kind === 'sql') {
    if (language !== 'sql') throw new Error('SQL problems are answered in SQL.');
    return { language: 'python', source: sqlHarness(problem, source, tag) };
  }
  if (language === 'sql') throw new Error('This problem is not a SQL problem.');
  switch (language) {
    case 'javascript': case 'typescript': return { language, source: source + '\n' + jsHarness(problem.signature, tag) };
    case 'python': return { language, source: source + '\n' + pythonHarness(problem.signature, tag) };
    // A public Solution class would have to live in Solution.java; the harness's Main is the public class.
    case 'java': return { language, source: JAVA_PRELUDE + source.replace(/\bpublic\s+(final\s+)?class\s+Solution\b/, 'class Solution') + '\n' + javaHarness(problem.signature, tag) };
    case 'cpp': return { language, source: CPP_PRELUDE + source + '\n' + cppHarness(problem.signature, tag) };
  }
}

// Points compiler and runtime messages at the candidate's own line numbers and hides harness lines.
export function mapMessage(text: string, language: CodeLanguage | 'sql', sourceLines: number): string {
  const offset = PRELUDE_LINES[language];
  const fix = (n: string) => { const line = Number(n) - offset; return line >= 1 && line <= sourceLines ? `line ${line}` : 'harness'; };
  return text
    .replace(/Main\.java:(\d+)/g, (_, n) => fix(n))
    .replace(/main\.cpp:(\d+)(:\d+)?/g, (_, n) => fix(n))
    .replace(/File "main\.py", line (\d+)/g, (_, n) => `File "main.py", ${fix(n)}`)
    .replace(/main\.(js|ts):(\d+)(:\d+)?/g, (_, _ext, n) => fix(n))
    .replace(/\/sandbox\/run-[0-9a-f]+\//g, '')
    .slice(0, 4000);
}
