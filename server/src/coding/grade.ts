import { mapMessage, marker } from './harness.js';
import type { Compare, Problem, SubmissionLanguage, TestCase, TestStatus, ValueType, Verdict } from './types.js';

// Test outcomes come only from running the code; no model is involved in grading.
export type RunnerResponse = {
  status: 'ok' | 'compile_error' | 'compile_timeout' | 'runtime_error' | 'timeout' | 'memory' | 'output_limit' | 'invalid' | 'internal_error';
  compile?: { ms: number; output: string };
  run?: { ms: number; exitCode: number | null; signal: string | null; stdout: string; stdoutTruncated: boolean; stderr: string; stderrTruncated: boolean };
};
export type TestOutcome = { index: number; visible: boolean; large: boolean; status: TestStatus; ms?: number; error?: string; actual?: unknown };
export type Graded = { verdict: Verdict; passed: number; total: number; tests: TestOutcome[]; output: string; message?: string; runMs?: number; compileMs?: number };

type Line = { i: number; ok: boolean; v?: unknown; error?: string; ms?: number };

export function parseOutput(stdout: string, nonce: string) {
  const tag = marker(nonce);
  const records = new Map<number, Line>();
  const other: string[] = [];
  let setupError: string | undefined;
  for (const line of stdout.split('\n')) {
    const at = line.indexOf(tag);
    if (at < 0) { if (line.trim()) other.push(line); continue; }
    if (at > 0) other.push(line.slice(0, at));
    try {
      const record = JSON.parse(line.slice(at + tag.length)) as Line;
      if (record.i === -1) setupError = record.error;
      else if (Number.isInteger(record.i) && !records.has(record.i)) records.set(record.i, record);
    } catch { other.push('[a result could not be read]'); }
  }
  return { records, setupError, output: other.join('\n').slice(0, 4000) };
}

const FLOAT_TYPES: ValueType[] = ['double', 'double[]'];
const canonical = (v: unknown): string => JSON.stringify(v);
function same(a: unknown, b: unknown, float: boolean): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return float ? Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)) : a === b;
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, k) => same(x, b[k], float));
  return a === b;
}
export function matches(actual: unknown, expected: unknown, compare: Compare = 'exact', float = false): boolean {
  if (compare === 'exact' || !Array.isArray(actual) || !Array.isArray(expected)) return same(actual, expected, float);
  const inner = (rows: unknown[]) => compare === 'unordered-nested'
    ? rows.map(r => (Array.isArray(r) ? [...r].sort((x, y) => canonical(x).localeCompare(canonical(y))) : r)) : rows;
  const sort = (rows: unknown[]) => inner(rows).sort((x, y) => canonical(x).localeCompare(canonical(y)));
  return same(sort([...actual]), sort([...expected]), float);
}

export function grade(problem: Problem, language: SubmissionLanguage, sourceLines: number, tests: TestCase[], nonce: string, response: RunnerResponse): Graded {
  const total = tests.length;
  const notRun = (t: TestCase): TestOutcome => ({ index: t.index, visible: t.visible, large: t.large, status: 'not_run' });
  if (response.status === 'compile_error' || response.status === 'compile_timeout') {
    return { verdict: 'compile_error', passed: 0, total, tests: tests.map(notRun), output: '',
      message: response.status === 'compile_timeout' ? 'Compilation took too long.' : mapMessage(response.compile?.output ?? '', language, sourceLines), compileMs: response.compile?.ms };
  }
  if (!response.run || response.status === 'invalid' || response.status === 'internal_error') {
    return { verdict: 'runner_error', passed: 0, total, tests: tests.map(notRun), output: '', message: 'The code runner could not run this submission.' };
  }
  const { records, setupError, output } = parseOutput(response.run.stdout, nonce);
  const float = problem.kind !== 'sql' && FLOAT_TYPES.includes(problem.signature.returns);
  const compare: Compare = problem.kind === 'sql' ? (problem.ordered ? 'exact' : 'unordered') : problem.compare ?? 'exact';
  const outcomes = tests.map((t, position): TestOutcome => {
    const record = records.get(position);
    if (!record) return notRun(t);
    const base = { index: t.index, visible: t.visible, large: t.large, ms: typeof record.ms === 'number' ? Math.round(record.ms * 10) / 10 : undefined };
    if (!record.ok) return { ...base, status: 'error', error: mapMessage(String(record.error ?? 'Error'), language, sourceLines) };
    const passed = matches(record.v, t.expected, compare, float || problem.kind === 'sql');
    // Hidden tests never reveal what the code returned, so the expected answer cannot be read back from them.
    return { ...base, status: passed ? 'passed' : 'wrong_answer', ...(t.visible ? { actual: record.v } : {}) };
  });
  const passed = outcomes.filter(o => o.status === 'passed').length;
  const stderr = mapMessage(response.run.stderr, language, sourceLines);
  const missing = outcomes.some(o => o.status === 'not_run');
  let verdict: Verdict;
  let message: string | undefined;
  if (setupError) { verdict = 'runtime_error'; message = setupError; }
  else if (passed === total) verdict = 'accepted';
  else if (outcomes.some(o => o.status === 'wrong_answer')) verdict = 'wrong_answer';
  else if (missing && response.status === 'timeout') { verdict = 'time_limit'; message = 'Time limit exceeded: the remaining tests did not finish in time.'; }
  else if (missing && response.status === 'memory') { verdict = 'memory_limit'; message = 'Memory limit exceeded.'; }
  else if (missing && response.status === 'output_limit') { verdict = 'output_limit'; message = 'Your program printed too much output.'; }
  else { verdict = 'runtime_error'; message = outcomes.find(o => o.error)?.error ?? (stderr.trim() || 'Your program stopped before finishing every test.'); }
  // A wrong answer before a timeout still reports the timeout, which usually points at complexity.
  if (verdict === 'wrong_answer' && missing && response.status === 'timeout') message = 'Some answers were wrong, and the remaining tests did not finish in time.';
  return { verdict, passed, total, tests: outcomes, output: [output, stderr.trim() && verdict !== 'accepted' ? stderr : ''].filter(Boolean).join('\n').slice(0, 4000),
    message, runMs: response.run.ms, compileMs: response.compile?.ms };
}
