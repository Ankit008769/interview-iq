import type { Problem, Rng, SubmissionLanguage, TestCase } from './types.js';

// Deterministic test sets: examples are visible; hidden tests add edge cases and seeded large inputs.
export function seededRandom(seed: number): Rng {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const seedFor = (id: string) => [...id].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);

function build(problem: Problem): TestCase[] {
  if (problem.kind === 'sql') {
    return [...problem.examples.map(e => ({ seed: e.seed, expected: e.expected, visible: true })), ...problem.tests.map(t => ({ ...t, visible: false }))]
      .map((t, index) => ({ index, visible: t.visible, large: false, args: [t.seed], expected: t.expected }));
  }
  const cases = [
    ...problem.examples.map(e => ({ args: e.args, visible: true, large: false })),
    ...problem.tests.map(args => ({ args, visible: false, large: false })),
    ...(problem.generate?.(seededRandom(seedFor(problem.id))) ?? []).map(args => ({ args, visible: false, large: true })),
  ];
  // References may sort or modify their inputs, so each gets its own copy.
  return cases.map((c, index) => ({ index, visible: c.visible, large: c.large, args: c.args, expected: problem.reference(...structuredClone(c.args)) }));
}

// Generated inputs are large, so only recently used problems keep theirs in memory.
const cache = new Map<string, TestCase[]>();
const CACHE_SIZE = 6;
export function testCases(problem: Problem, mode: 'run' | 'submit'): TestCase[] {
  let all = cache.get(problem.id);
  if (all) cache.delete(problem.id); else all = build(problem);
  cache.set(problem.id, all);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return mode === 'run' ? all.filter(t => t.visible) : all;
}
export const exampleCases = (problem: Problem) => testCases(problem, 'run');

export const stdinFor = (tests: TestCase[]) => tests.map(t => JSON.stringify(t.args)).join('\n') + '\n';

// Slower runtimes get proportionally more time, plus their start-up cost.
const FACTOR: Record<SubmissionLanguage, number> = { cpp: 1, java: 1.5, javascript: 1.2, typescript: 1.2, python: 3, sql: 1 };
const STARTUP_MS: Record<SubmissionLanguage, number> = { cpp: 300, java: 1200, javascript: 500, typescript: 700, python: 400, sql: 400 };
export function runTimeLimit(problem: Problem, language: SubmissionLanguage, mode: 'run' | 'submit') {
  const work = mode === 'run' ? Math.min(problem.timeLimitMs, 1000) : problem.timeLimitMs;
  return Math.min(15_000, Math.round(work * FACTOR[language] + STARTUP_MS[language]));
}
