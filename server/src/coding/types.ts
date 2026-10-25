import type { InterviewLevel } from '../models/Interview.js';

// Coding lab (roadmap C2). Values cross the runner boundary as JSON, so problems use a closed set of types
// that every language harness can parse and print.
export const VALUE_TYPES = ['int', 'long', 'double', 'bool', 'string', 'int[]', 'double[]', 'string[]', 'int[][]', 'string[][]'] as const;
export type ValueType = typeof VALUE_TYPES[number];
export const CODE_LANGUAGES = ['javascript', 'typescript', 'python', 'java', 'cpp'] as const;
export type CodeLanguage = typeof CODE_LANGUAGES[number];
// SQL problems are answered in SQL and run by a Python harness against an in-memory SQLite database.
export type SubmissionLanguage = CodeLanguage | 'sql';
export const LANGUAGE_LABELS: Record<SubmissionLanguage, string> = {
  javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python 3', java: 'Java 17', cpp: 'C++17', sql: 'SQL (SQLite)',
};

export type Signature = { name: string; params: { name: string; type: ValueType }[]; returns: ValueType };
// exact: same value; unordered: the top-level list in any order; unordered-nested: inner lists and their order both free.
export type Compare = 'exact' | 'unordered' | 'unordered-nested';
export type Rng = () => number;

type Common = {
  id: string; title: string; difficulty: InterviewLevel; topics: string[];
  statement: string; constraints: string[];
  // Time for all tests together on the fastest runtime; slower runtimes get proportionally more.
  timeLimitMs: number;
  // What a strong solution achieves, given to the AI interviewer only, never shown as the answer.
  complexity: string;
};
export type FunctionProblem = Common & {
  kind: 'algorithm' | 'debugging';
  signature: Signature;
  examples: { args: unknown[]; explanation?: string }[];
  tests: unknown[][];
  // Large inputs, generated from a seeded random source so every run sees the same cases.
  generate?: (rng: Rng) => unknown[][];
  reference: (...args: any[]) => unknown;
  compare?: Compare;
  languages?: CodeLanguage[];
  starter?: Partial<Record<CodeLanguage, string>>;
};
export type SqlRow = (string | number | null)[];
export type SqlProblem = Common & {
  kind: 'sql';
  schema: string;
  examples: { seed: string; expected: SqlRow[]; explanation?: string }[];
  tests: { seed: string; expected: SqlRow[] }[];
  columns: string[];
  ordered: boolean;
  reference: string;
};
export type Problem = FunctionProblem | SqlProblem;

export type TestCase = { index: number; visible: boolean; large: boolean; args: unknown[]; expected: unknown };
export type TestStatus = 'passed' | 'wrong_answer' | 'error' | 'not_run';
export type Verdict = 'accepted' | 'wrong_answer' | 'runtime_error' | 'time_limit' | 'memory_limit' | 'output_limit' | 'compile_error' | 'runner_error';
