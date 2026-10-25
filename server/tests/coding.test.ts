import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { CodeRun } from '../src/models/CodeRun.js';
import { PROBLEMS, PROBLEM_BY_ID } from '../src/coding/problems.js';
import { buildProgram, mapMessage, starterCode } from '../src/coding/harness.js';
import { grade, matches, parseOutput } from '../src/coding/grade.js';
import { runTimeLimit, testCases } from '../src/coding/tests.js';
import { CODE_LANGUAGES, VALUE_TYPES, type FunctionProblem } from '../src/coding/types.js';

process.env.JWT_SECRET = 'coding-test-secret-longer-than-thirty-two-characters';
const { app } = await import('../src/app.js');

const TWO_SUM_JS = 'function twoSum(nums, target) {\n  const seen = new Map();\n  for (let i = 0; i < nums.length; i++) {\n    if (seen.has(target - nums[i])) return [seen.get(target - nums[i]), i];\n    seen.set(nums[i], i);\n  }\n}\n';
const twoSum = PROBLEM_BY_ID.get('two-sum') as FunctionProblem;

// Test-only stand-in for the runner: it really executes JavaScript and TypeScript with Node, without a
// sandbox, on loopback. Other languages report that they are unavailable.
const runnerCalls: any[] = [];
let runnerLanguages: Record<string, string | null> = { javascript: 'node', typescript: 'node', python: 'python', java: null, cpp: null };
const runner = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  res.setHeader('content-type', 'application/json');
  if (req.url === '/health') { res.end(JSON.stringify({ ok: true, languages: runnerLanguages })); return; }
  const input = JSON.parse(body); runnerCalls.push(input);
  if (!['javascript', 'typescript'].includes(input.language)) { res.end(JSON.stringify({ status: 'compile_error', compile: { ms: 1, output: 'Main.java:5: error: \';\' expected' } })); return; }
  const dir = mkdtempSync(join(tmpdir(), 'iq-fake-runner-'));
  try {
    const file = join(dir, input.language === 'typescript' ? 'main.ts' : 'main.js');
    writeFileSync(file, input.source);
    const started = Date.now();
    const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', file], { input: input.stdin, encoding: 'utf8', timeout: input.timeLimitMs });
    const timedOut = result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    res.end(JSON.stringify({ status: timedOut ? 'timeout' : result.status === 0 ? 'ok' : 'runtime_error', runner: { version: 'fake' },
      run: { ms: Date.now() - started, exitCode: result.status, signal: result.signal, stdout: result.stdout ?? '', stdoutTruncated: false, stderr: result.stderr ?? '', stderrTruncated: false } }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Stub AI gateway: a follow-up question, then a review whose first quote comes from the code and second is invented.
const aiCalls: { system: string; input: any }[] = [];
const gateway = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const parsed = JSON.parse(body); const input = JSON.parse(parsed.messages[1].content);
  aiCalls.push({ system: parsed.messages[0].content, input });
  const value = input.candidateExplanation
    ? { summary: 'A clear hash-map solution with a correct complexity claim.', criteria: [
      { criterionId: 'approach', score: 5, quote: 'const seen = new Map();', rationale: 'Uses a hash map.', improvement: null },
      { criterionId: 'complexity', score: 4, quote: 'This invented quote is not in the answer', rationale: 'States O(n).', improvement: 'Mention space.' },
      { criterionId: 'quality', score: 4, quote: 'seen.set(nums[i], i);', rationale: 'Readable.', improvement: 'Name the complement.' },
      { criterionId: 'explanation', score: 4, quote: 'one pass with a hash map', rationale: 'Explains the idea.', improvement: null }] }
    : { question: 'What is the time and space complexity of your solution, and why?' };
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ id: 'chatcmpl_test', object: 'chat.completion', created: 1, model: parsed.model,
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(value), refusal: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 } }));
});

let mongo: MongoMemoryServer;
const owner = request.agent(app), other = request.agent(app);
const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

beforeAll(async () => {
  const [runnerPort, gatewayPort] = await Promise.all([listen(runner), listen(gateway)]);
  vi.stubEnv('RUNNER_URL', `http://127.0.0.1:${runnerPort}`); vi.stubEnv('RUNNER_AUTH', 'none');
  vi.stubEnv('AI_PROVIDER', 'compatible'); vi.stubEnv('LLM_BASE_URL', `http://127.0.0.1:${gatewayPort}/v1`);
  vi.stubEnv('INTERVIEWER_MODEL', 'iq-interviewer'); vi.stubEnv('JUDGE_MODEL', 'iq-judge');
  vi.stubEnv('INTERVIEW_WRITES_PER_15_MIN', '500'); vi.stubEnv('CODE_RUNS_PER_15_MIN', '500');
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  for (const [agent, email] of [[owner, 'coder@example.test'], [other, 'other-coder@example.test']] as const) {
    await agent.post('/api/auth/register').send({ name: 'Coder', email, password: 'test-password' }).expect(201);
  }
}, 120_000);
beforeEach(async () => { runnerCalls.length = 0; aiCalls.length = 0; await CodeRun.deleteMany({}); });
afterAll(async () => { vi.unstubAllEnvs(); await mongoose.disconnect(); await mongo?.stop(); runner.close(); gateway.close(); });

describe('problem catalogue', () => {
  it('has unique ids, valid signatures, examples, starters and consistent references', () => {
    expect(new Set(PROBLEMS.map(p => p.id)).size).toBe(PROBLEMS.length);
    expect(PROBLEMS.filter(p => p.kind === 'algorithm').length).toBeGreaterThanOrEqual(25);
    expect(PROBLEMS.filter(p => p.kind === 'debugging').length).toBeGreaterThanOrEqual(4);
    expect(PROBLEMS.filter(p => p.kind === 'sql').length).toBeGreaterThanOrEqual(5);
    for (const p of PROBLEMS) {
      expect(p.examples.length, p.id).toBeGreaterThan(0);
      expect(p.complexity.length, p.id).toBeGreaterThan(10);
      if (p.kind === 'sql') { for (const t of [...p.examples, ...p.tests]) for (const row of t.expected) expect(row.length, p.id).toBe(p.columns.length); continue; }
      for (const type of [...p.signature.params.map(x => x.type), p.signature.returns]) expect(VALUE_TYPES, p.id).toContain(type);
      for (const language of p.languages ?? CODE_LANGUAGES) expect(starterCode(p, language).length, `${p.id} ${language}`).toBeGreaterThan(10);
      if (p.kind === 'debugging') for (const language of p.languages!) expect(p.starter?.[language], `${p.id} ${language}`).toBeTruthy();
    }
  });
  it('computes known answers and the same generated tests every time', () => {
    const answers = testCases(twoSum, 'run').map(t => t.expected);
    expect(answers).toEqual([[0, 1], [1, 2], [0, 1]]);
    expect(testCases(PROBLEM_BY_ID.get('valid-parentheses')!, 'run').map(t => t.expected)).toEqual([true, true, false, true]);
    expect(testCases(PROBLEM_BY_ID.get('climbing-stairs')!, 'submit').at(-1)!.expected).toBe(308061521170129);
    const first = testCases(twoSum, 'submit'); const large = first.filter(t => t.large);
    expect(large).toHaveLength(2); expect((large[0].args[0] as number[]).length).toBe(100_000);
    // Rebuilt after leaving the cache, the generated tests are identical.
    for (const p of PROBLEMS.slice(1, 9)) testCases(p, 'submit');
    expect(JSON.stringify(testCases(twoSum, 'submit'))).toBe(JSON.stringify(first));
    expect(runTimeLimit(twoSum, 'python', 'submit')).toBeGreaterThan(runTimeLimit(twoSum, 'cpp', 'submit'));
  });
});

describe('harness and grading', () => {
  it('generates idiomatic starters for every language', () => {
    expect(starterCode(twoSum, 'python')).toBe('def two_sum(nums: list[int], target: int) -> list[int]:\n    # Write your solution here\n    pass\n');
    expect(starterCode(twoSum, 'java')).toContain('public int[] twoSum(int[] nums, int target)');
    expect(starterCode(twoSum, 'cpp')).toContain('vector<int> twoSum(vector<int>& nums, int target)');
    expect(starterCode(twoSum, 'typescript')).toContain('function twoSum(nums: number[], target: number): number[]');
    expect(starterCode(PROBLEM_BY_ID.get('group-anagrams') as FunctionProblem, 'java')).toContain('public List<List<String>> groupAnagrams(String[] strs)');
  });
  it('makes the Java Solution class package-private and maps error lines back to the candidate', () => {
    const java = buildProgram(twoSum, 'java', 'public class Solution {\n}\n', 'n0nce').source;
    expect(java).toContain('\nclass Solution {'); expect(java).toContain('public class Main');
    expect(mapMessage('Main.java:3: error: missing return', 'java', 2)).toBe('line 1: error: missing return');
    expect(mapMessage('main.cpp:40:5: error', 'cpp', 3)).toBe('harness: error');
    expect(mapMessage('File "main.py", line 2, in two_sum', 'python', 5)).toBe('File "main.py", line 2, in two_sum');
    expect(() => buildProgram(twoSum, 'sql', 'SELECT 1', 'x')).toThrow();
  });
  it('reads only tagged results, so printed text cannot pose as a result', () => {
    const parsed = parseOutput('debug line\n@@IQ:abc:{"i":0,"ok":true,"v":[0,1]}\n@@IQ:forged:{"i":1,"ok":true,"v":[9]}\n@@IQ:abc:{"i":0,"ok":true,"v":[5]}\n', 'abc');
    expect([...parsed.records.keys()]).toEqual([0]);
    expect(parsed.records.get(0)!.v).toEqual([0, 1]);
    expect(parsed.output).toContain('debug line');
  });
  it('compares exactly, in any order or with float tolerance only where the problem allows', () => {
    expect(matches([1, 2], [2, 1])).toBe(false);
    expect(matches([1, 2], [2, 1], 'unordered')).toBe(true);
    expect(matches([['tea', 'eat'], ['bat']], [['bat'], ['eat', 'tea']], 'unordered-nested')).toBe(true);
    expect(matches(2.5000001, 2.5, 'exact', true)).toBe(true);
    expect(matches(1000000008, 1000000007)).toBe(false);
  });
  it('turns runner results into verdicts without revealing hidden outputs', () => {
    const tests = testCases(twoSum, 'submit');
    const line = (i: number, v: unknown) => `@@IQ:n:${JSON.stringify({ i, ok: true, ms: 1, v })}`;
    const all = tests.map(t => line(t.index, t.expected)).join('\n');
    const ok = grade(twoSum, 'javascript', 5, tests, 'n', { status: 'ok', run: { ms: 10, exitCode: 0, signal: null, stdout: all, stdoutTruncated: false, stderr: '', stderrTruncated: false } });
    expect(ok).toMatchObject({ verdict: 'accepted', passed: tests.length, total: tests.length });
    expect(ok.tests.filter(t => !t.visible).every(t => !('actual' in t))).toBe(true);
    const partial = tests.slice(0, 5).map(t => line(t.index, t.expected)).join('\n');
    const timeout = grade(twoSum, 'python', 5, tests, 'n', { status: 'timeout', run: { ms: 9000, exitCode: null, signal: 'SIGKILL', stdout: partial, stdoutTruncated: false, stderr: '', stderrTruncated: false } });
    expect(timeout.verdict).toBe('time_limit'); expect(timeout.tests.at(-1)!.status).toBe('not_run');
    const wrong = grade(twoSum, 'python', 5, tests, 'n', { status: 'ok', run: { ms: 9, exitCode: 0, signal: null, stdout: tests.map(t => line(t.index, [9, 9])).join('\n'), stdoutTruncated: false, stderr: '', stderrTruncated: false } });
    expect(wrong.verdict).toBe('wrong_answer'); expect(wrong.tests[0].actual).toEqual([9, 9]);
    const compile = grade(twoSum, 'java', 5, tests, 'n', { status: 'compile_error', compile: { ms: 5, output: 'Main.java:4: error: x' } });
    expect(compile).toMatchObject({ verdict: 'compile_error', message: 'line 2: error: x' });
    const setup = grade(twoSum, 'javascript', 5, tests, 'n', { status: 'ok', run: { ms: 9, exitCode: 0, signal: null, stdout: '@@IQ:n:{"i":-1,"ok":false,"error":"Define a function named twoSum."}', stdoutTruncated: false, stderr: '', stderrTruncated: false } });
    expect(setup).toMatchObject({ verdict: 'runtime_error', message: 'Define a function named twoSum.' });
  });
});

describe('coding API', () => {
  it('lists problems and shows one without exposing hidden tests', async () => {
    const list = (await owner.get('/api/coding/problems').expect(200)).body.problems;
    expect(list).toHaveLength(PROBLEMS.length);
    expect(list.find((p: any) => p.id === 'debug-average')).toMatchObject({ kind: 'debugging', languages: ['javascript', 'typescript', 'python'], solved: false });
    const detail = (await owner.get('/api/coding/problems/two-sum').expect(200)).body;
    expect(detail.problem.examples[0]).toEqual({ args: [[2, 7, 11, 15], 9], expected: [0, 1], explanation: 'nums[0] + nums[1] = 2 + 7 = 9.' });
    expect(detail.problem.hiddenTests).toBe(testCases(twoSum, 'submit').length - 3);
    expect(JSON.stringify(detail)).not.toContain('1000000000, -999999993');
    expect(detail.problem.starters.java).toContain('class Solution');
    const sql = (await owner.get('/api/coding/problems/sql-high-earners').expect(200)).body.problem;
    expect(sql).toMatchObject({ languages: ['sql'], columns: ['name', 'salary'] });
    await owner.get('/api/coding/problems/nope').expect(404);
    await request(app).get('/api/coding/problems').expect(401);
    expect((await owner.get('/api/coding/status').expect(200)).body).toMatchObject({ runner: { configured: true, ready: true }, aiAvailable: true });
  });

  it('runs examples, then grades a submission against hidden tests in the runner', async () => {
    const run = (await owner.post('/api/coding/problems/two-sum/runs').send({ language: 'javascript', source: TWO_SUM_JS, mode: 'run' }).expect(201)).body.run;
    expect(run).toMatchObject({ verdict: 'accepted', passed: 3, total: 3, mode: 'run', problemTitle: 'Two Sum' });
    expect(run.tests[0]).toMatchObject({ visible: true, status: 'passed', actual: [0, 1] });
    expect(runnerCalls[0]).toMatchObject({ language: 'javascript' }); expect(runnerCalls[0].stdin.split('\n').filter(Boolean)).toHaveLength(3);
    expect(runnerCalls[0].source).not.toContain('[0,1]'); // expected answers stay in the app
    const submitted = (await owner.post('/api/coding/problems/two-sum/runs').send({ language: 'typescript', source: TWO_SUM_JS, mode: 'submit' }).expect(201)).body.run;
    expect(submitted).toMatchObject({ verdict: 'accepted', mode: 'submit' }); expect(submitted.total).toBeGreaterThan(5);
    expect(submitted.tests.filter((t: any) => !t.visible).every((t: any) => t.actual === undefined)).toBe(true);
    const wrong = (await owner.post('/api/coding/problems/two-sum/runs').send({ language: 'javascript', source: 'function twoSum() { return [0, 0]; }', mode: 'submit' }).expect(201)).body.run;
    expect(wrong.verdict).toBe('wrong_answer');
    const slow = (await owner.post('/api/coding/problems/two-sum/runs').send({ language: 'javascript', source: 'function twoSum() { while (true) {} }', mode: 'submit' }).expect(201)).body.run;
    expect(slow.verdict).toBe('time_limit');
    const listed = (await owner.get('/api/coding/problems').expect(200)).body.problems.find((p: any) => p.id === 'two-sum');
    expect(listed).toMatchObject({ solved: true, submissions: 3 });
    expect((await owner.get('/api/coding/problems/two-sum').expect(200)).body.runs).toHaveLength(4);
    await other.get(`/api/coding/runs/${submitted.id}`).expect(404);
    expect((await owner.get(`/api/coding/runs/${submitted.id}`).expect(200)).body.run.source).toBe(TWO_SUM_JS);
  });

  it('rejects other languages, unavailable runtimes, empty code and an unreachable runner', async () => {
    await owner.post('/api/coding/problems/two-sum/runs').send({ language: 'sql', source: 'SELECT 1', mode: 'run' }).expect(400);
    await owner.post('/api/coding/problems/debug-average/runs').send({ language: 'java', source: 'class Solution {}', mode: 'run' }).expect(400);
    await owner.post('/api/coding/problems/two-sum/runs').send({ language: 'javascript', source: '   ', mode: 'run' }).expect(400);
    expect((await owner.post('/api/coding/problems/two-sum/runs').send({ language: 'java', source: 'class Solution {}', mode: 'run' }).expect(409)).body.error).toMatch(/not available/);
    runnerLanguages = { ...runnerLanguages, java: 'javac' };
    try {
      await new Promise(r => setTimeout(r, 0));
      vi.stubEnv('RUNNER_URL', 'http://127.0.0.1:9'); // nothing listens here
      const failed = await owner.post('/api/coding/problems/two-sum/runs').send({ language: 'javascript', source: TWO_SUM_JS, mode: 'run' }).expect(503);
      expect(failed.body.code).toBe('RUNNER_UNAVAILABLE');
      expect(await CodeRun.countDocuments()).toBe(0);
    } finally {
      vi.stubEnv('RUNNER_URL', `http://127.0.0.1:${(runner.address() as AddressInfo).port}`);
      runnerLanguages = { ...runnerLanguages, java: null };
    }
  });

  it('asks one follow-up question, then reviews the explanation with verified quotes', async () => {
    const submitted = (await owner.post('/api/coding/problems/two-sum/runs').send({ language: 'javascript', source: TWO_SUM_JS, mode: 'submit' }).expect(201)).body.run;
    const example = (await owner.post('/api/coding/problems/two-sum/runs').send({ language: 'javascript', source: TWO_SUM_JS, mode: 'run' }).expect(201)).body.run;
    // Without AI permission nothing is sent to the model.
    expect((await owner.post(`/api/coding/runs/${submitted.id}/follow-up`).send({}).expect(409)).body.code).toBe('AI_CONSENT_REQUIRED');
    expect(aiCalls).toHaveLength(0);
    const { disclosure } = (await owner.get('/api/account/ai-consent').expect(200)).body;
    expect(disclosure.coding).toMatch(/sandbox with no network access/);
    await owner.post('/api/account/ai-consent').send({ version: disclosure.version, accepted: true }).expect(200);
    await owner.post(`/api/coding/runs/${example.id}/follow-up`).send({}).expect(409);
    await owner.post(`/api/coding/runs/${submitted.id}/answer`).send({ answer: 'one pass with a hash map, O(n) time.' }).expect(409);
    const asked = (await owner.post(`/api/coding/runs/${submitted.id}/follow-up`).send({}).expect(201)).body.run;
    expect(asked.followUp.question).toMatch(/complexity/);
    expect(aiCalls[0].input).toMatchObject({ language: 'JavaScript', code: TWO_SUM_JS, testResults: { verdict: 'accepted' } });
    expect(aiCalls[0].system).toContain('referenceComplexity is for you only');
    expect((await owner.post(`/api/coding/runs/${submitted.id}/follow-up`).send({}).expect(200)).body.replayed).toBe(true);
    expect(aiCalls).toHaveLength(1);
    await owner.post(`/api/coding/runs/${submitted.id}/answer`).send({ answer: 'short' }).expect(400);
    const reviewed = (await owner.post(`/api/coding/runs/${submitted.id}/answer`).send({ answer: 'I do one pass with a hash map from value to index, so it is O(n) time and O(n) space.' }).expect(201)).body.run;
    const criteria = reviewed.followUp.review.criteria;
    expect(criteria.map((c: any) => c.criterionId)).toEqual(['approach', 'complexity', 'quality', 'explanation']);
    expect(criteria[0]).toMatchObject({ score: 5, status: 'rated', evidence: { quote: 'const seen = new Map();' } });
    expect(criteria[1]).toMatchObject({ score: null, status: 'insufficient_evidence' }); // the invented quote is dropped
    expect(criteria[3]).toMatchObject({ score: 4, evidence: { quote: 'one pass with a hash map' } });
    expect(reviewed.verdict).toBe('accepted'); // the review never changes the test result
    expect(aiCalls[1].input.candidateExplanation).toMatch(/O\(n\) time/);
    expect((await owner.post(`/api/coding/runs/${submitted.id}/answer`).send({ answer: 'A different explanation of the same code.' }).expect(200)).body.replayed).toBe(true);
  });
});
