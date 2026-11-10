import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { zipSync, strToU8 } from 'fflate';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { Interview } from '../src/models/Interview.js';
import { Project } from '../src/models/Project.js';
import { scanSecrets, isSecretFile } from '../src/projects/secrets.js';
import { ingestZip, normalizePath, ProjectZipError } from '../src/projects/ingest.js';
import { findDependencies, indexSymbols } from '../src/projects/codeIndex.js';
import { pickTarget, type QuestionProject } from '../src/projects/service.js';
import { checkClaim } from '../src/projects/claims.js';
import { REMOVED_QUESTION } from '../src/services/documents.js';

process.env.JWT_SECRET = 'projects-test-secret-longer-than-thirty-two-characters';
const { app } = await import('../src/app.js');
const { processNextInterviewJob } = await import('../src/services/interviewJobs.js');

// Every value here must never appear in anything stored, returned, logged or sent to a model.
const SECRETS = ['AKIAIOSFODNN7EXAMPLE', 'Pa55w0rdXYZ', 'hunter2hunter2', 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8', 'SuperSecret123', 'abcdefghijklmnopq-jwt-secret'];
const SERVER_JS = `const express = require('express');
const jwt = require('jsonwebtoken');
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const db = 'mongodb+srv://appuser:Pa55w0rdXYZ@cluster0.example.net/app';
const app = express();

function verifyToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.replace('Bearer ', '');
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'invalid token' }); }
}

app.post('/api/login', async (req, res) => {
  const password = "hunter2hunter2";
  const ok = req.body.password === password;
  if (!ok) return res.status(401).end();
  res.json({ token: jwt.sign({ id: req.body.id }, process.env.JWT_SECRET, { expiresIn: '1h' }) });
});

module.exports = { app, verifyToken };
`;
const CHAT_JS = `const { Server } = require('socket.io');

function broadcastMessage(io, room, message) {
  if (!message || !message.text) throw new Error('empty message');
  const payload = { ...message, at: Date.now() };
  io.to(room).emit('message', payload);
  return payload;
}

module.exports = { broadcastMessage };
`;
const WINDOW_JSX = `export function ChatWindow({ messages }) {
  return (
    <ul>
      {messages.map(m => <li key={m.id}>{m.text}</li>)}
    </ul>
  );
}
`;
function projectZip(extra: Record<string, Uint8Array> = {}) {
  return Buffer.from(zipSync({
    'myapp/package.json': strToU8(JSON.stringify({ name: 'myapp', dependencies: { express: '^4.19.0', jsonwebtoken: '^9.0.0', 'socket.io': '^4.7.0' }, devDependencies: { vitest: '^1.0.0' } })),
    'myapp/package-lock.json': strToU8('{"lockfileVersion":3}'),
    'myapp/.env': strToU8('MONGO_URI=mongodb://admin:SuperSecret123@db:27017/app\nJWT_SECRET=abcdefghijklmnopq-jwt-secret\n'),
    'myapp/keys/server.pem': strToU8('-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n'),
    'myapp/node_modules/lib/index.js': strToU8('module.exports = 1;'),
    'myapp/src/server.js': strToU8(SERVER_JS),
    'myapp/src/chat.js': strToU8(CHAT_JS),
    'myapp/src/components/ChatWindow.jsx': strToU8(WINDOW_JSX),
    'myapp/src/server.test.js': strToU8("test('login', () => { expect(1).toBe(1); });\nfunction helperOnlyForTests() {\n  return 1;\n  // padding\n}\n"),
    'myapp/scripts/deploy.sh': strToU8(`#!/bin/sh\nexport GITHUB_TOKEN=${SECRETS[3]}\ngit push\n`),
    'myapp/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]),
    'myapp/src/big.js': strToU8('// ' + 'x'.repeat(300 * 1024)),
    ...extra,
  }));
}
const leaks = (text: string) => SECRETS.filter(s => text.includes(s));

describe('secret scanning', () => {
  it('redacts secret values, keeps placeholders, and reports file, line and kind only', () => {
    const text = `const a = 'AKIAIOSFODNN7EXAMPLE';\nconst uri = "postgres://me:${'s3cretPass99'}@host/db";\npassword = "changeme"\napiKey: process.env.KEY\nclient_secret = 'zq8Xw2Lm9Pr4Ty7U'\n-----BEGIN RSA PRIVATE KEY-----\nAAAA\nBBBB\n-----END RSA PRIVATE KEY-----\nconst after = 1;\n`;
    const { text: out, findings } = scanSecrets('x.js', text);
    expect(findings).toEqual([{ path: 'x.js', line: 1, kind: 'AWS access key' }, { path: 'x.js', line: 2, kind: 'connection string password' },
      { path: 'x.js', line: 5, kind: 'hard-coded secret' }, { path: 'x.js', line: 6, kind: 'private key' }]);
    for (const value of ['AKIAIOSFODNN7EXAMPLE', 's3cretPass99', 'zq8Xw2Lm9Pr4Ty7U', 'AAAA']) expect(out).not.toContain(value);
    expect(out).toContain('password = "changeme"'); expect(out).toContain('apiKey: process.env.KEY');
    expect(out.split('\n').length).toBe(text.split('\n').length);
    expect(out.split('\n')[9]).toBe('const after = 1;');
    expect(['.env', '.env.production', 'id_rsa', 'server.pem', 'credentials.json', 'my-service-account.json', '.npmrc'].every(isSecretFile)).toBe(true);
    expect(isSecretFile('server.js')).toBe(false);
  });
});

describe('zip ingestion and code index', () => {
  it('keeps only source text, drops dependency folders, binaries, secret files and oversized files', async () => {
    const ingested = await ingestZip(projectZip());
    expect(ingested.files.map(f => f.path)).toEqual(['package.json', 'scripts/deploy.sh', 'src/chat.js', 'src/components/ChatWindow.jsx', 'src/server.js', 'src/server.test.js']);
    expect(ingested.skipped).toMatchObject({ ignoredFolder: 1, secretFile: 2, tooLarge: 1 });
    expect(ingested.skipped.binaryOrOther).toBeGreaterThanOrEqual(2); // the lock file and the image
    expect(ingested.secretFiles.sort()).toEqual(['.env', 'keys/server.pem']);
    expect(ingested.secrets.map(s => `${s.path}:${s.line}:${s.kind}`)).toEqual(['scripts/deploy.sh:2:GitHub token', 'src/server.js:3:AWS access key',
      'src/server.js:4:connection string password', 'src/server.js:15:hard-coded secret']);
    expect(leaks(JSON.stringify(ingested))).toEqual([]);
    expect(normalizePath('../escape.js')).toBeNull(); expect(normalizePath('C:/x.js')).toBeNull(); expect(normalizePath('a\\b.js')).toBe('a/b.js');
    await expect(ingestZip(Buffer.from('not a zip at all'))).rejects.toBeInstanceOf(ProjectZipError);
    await expect(ingestZip(projectZip({ '../escape.js': strToU8('evil()') }))).rejects.toThrow(/outside the project folder/);
    await expect(ingestZip(Buffer.from(zipSync({ 'a/logo.png': new Uint8Array([0, 1, 2]) })))).rejects.toThrow(/No source files/);
    // A small archive that inflates to a huge file is refused by its declared size before inflating.
    const bomb = Buffer.from(zipSync({ 'src/a.js': new Uint8Array(20 * 1024 * 1024).fill(32), 'src/b.js': strToU8('const b = 1;') }));
    expect(bomb.length).toBeLessThan(100_000);
    expect((await ingestZip(bomb)).skipped.tooLarge).toBe(1);
  });

  it('indexes functions, routes, components and dependencies with tree-sitter', async () => {
    const { files } = await ingestZip(projectZip());
    const symbols = await indexSymbols(files);
    const names = symbols.map(s => `${s.kind} ${s.name} ${s.path}:${s.line}-${s.endLine}`);
    expect(names).toEqual(expect.arrayContaining(['function verifyToken src/server.js:7-12', 'route POST /api/login src/server.js:14-14',
      'function broadcastMessage src/chat.js:3-8', 'component ChatWindow src/components/ChatWindow.jsx:1-7']));
    expect(findDependencies(files).map(d => d.name)).toEqual(['express', 'jsonwebtoken', 'socket.io', 'vitest']);
  });

  it('picks a different real function each time, skipping tests, config and tiny helpers', async () => {
    const { files } = await ingestZip(projectZip());
    const project: QuestionProject = { _id: new mongoose.Types.ObjectId(), name: 'myapp', files, symbols: await indexSymbols(files), dependencies: findDependencies(files) };
    const asked: { path: string; symbol: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const target = pickTarget(project, asked, 'interview-1');
      if (!target) break;
      expect(target.path).not.toMatch(/test|package\.json/);
      asked.push({ path: target.path, symbol: target.name });
    }
    expect(new Set(asked.map(a => `${a.path}#${a.symbol}`)).size).toBe(asked.length);
    expect(new Set(asked.slice(0, 3).map(a => a.path)).size).toBe(3); // spread across files first
  });

  it('decides claim support from the code, not from the model', async () => {
    const { files } = await ingestZip(projectZip());
    const project = { files, symbols: await indexSymbols(files), dependencies: findDependencies(files) };
    const claim = (keywords: string[]) => checkClaim(project, { quote: 'q', start: 0, end: 1, keywords });
    const realtime = claim(['socket.io', 'broadcast']);
    expect(realtime.status).toBe('supported');
    expect(realtime.evidence[0]).toEqual({ path: 'package.json', line: 0, kind: 'dependency', text: 'socket.io ^4.7.0' });
    expect(claim(['jwt', 'auth']).status).not.toBe('not_found');
    expect(claim(['kubernetes', 'graphql'])).toMatchObject({ status: 'not_found', evidence: [] });
  });
});

describe('projects API and project defense interviews', () => {
  const ai: { system: string; body: string; input: any }[] = [];
  let nameTheCode = false;
  let invent = 0;
  const gateway = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body); const input = JSON.parse(parsed.messages[1].content);
    ai.push({ system: parsed.messages[0].content, body, input });
    const value = input.resume ? { claims: [
        { quote: 'Built a real-time chat app with Socket.IO and JWT login', keywords: ['socket.io', 'jwt'] },
        { quote: 'Deployed it on Kubernetes', keywords: ['kubernetes'] },
        { quote: 'A claim that is not in the resume at all', keywords: ['react'] }] }
      : input.turns ? { overall: { summary: 'Explained the code.', strengths: [], improvements: ['Say more.'], nextSteps: ['Practise.'] },
        answers: input.turns.map((t: any) => ({ questionIndex: t.questionIndex, verdict: 'partly_correct', verdictReason: 'Partly.', keyPoints: ['a', 'b'], tip: 'More detail.',
          criteria: input.rubric.criteria.map((c: any) => ({ criterionId: c.id, score: 3, quote: t.answer.slice(0, 15), rationale: 'Some.', improvement: 'More.' })) })) }
      : input.target ? { question: invent-- > 0 ? `Why does \`${input.target.name}\` call \`madeUpHelper\`?` : nameTheCode ? `Why does \`${input.target.name}\` work this way?` : 'Why did you design it this way?', topic: 'Project' }
      : { question: 'Plain question?', topic: 'General' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model: parsed.model,
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(value), refusal: null }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  let mongo: MongoMemoryServer;
  const owner = request.agent(app), other = request.agent(app);
  const logged: string[] = [];
  const upload = (agent: ReturnType<typeof request.agent>, name = 'Chat app', zip = projectZip()) =>
    agent.post('/api/projects').set('content-type', 'application/zip').set('x-project-name', encodeURIComponent(name)).send(zip);

  beforeAll(async () => {
    await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
    vi.stubEnv('AI_PROVIDER', 'compatible'); vi.stubEnv('LLM_BASE_URL', `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`);
    vi.stubEnv('INTERVIEWER_MODEL', 'iq-interviewer'); vi.stubEnv('JUDGE_MODEL', 'iq-judge'); vi.stubEnv('INTERVIEW_WRITES_PER_15_MIN', '500');
    mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
    for (const [agent, email] of [[owner, 'defender@example.test'], [other, 'other-defender@example.test']] as const) {
      await agent.post('/api/auth/register').send({ name: 'Defender', email, password: 'test-password' }).expect(201);
      const { disclosure } = (await agent.get('/api/account/ai-consent').expect(200)).body;
      await agent.post('/api/account/ai-consent').send({ version: disclosure.version, accepted: true }).expect(200);
    }
    for (const method of ['log', 'error', 'warn', 'info'] as const) {
      const original = console[method];
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); original(...args); });
    }
  }, 120_000);
  beforeEach(async () => { ai.length = 0; nameTheCode = false; invent = 0; await Promise.all([Project.deleteMany({}), Interview.deleteMany({})]); });
  afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await mongoose.disconnect(); await mongo?.stop(); gateway.close(); });

  it('uploads a zip, reports secrets without their values and enforces limits', async () => {
    const created = (await upload(owner).expect(201)).body.project;
    expect(created).toMatchObject({ name: 'Chat app', stats: { files: 6, dependencies: 4 }, secretFiles: expect.arrayContaining(['.env', 'keys/server.pem']) });
    expect(created.secrets).toHaveLength(4);
    expect(created.files.find((f: any) => f.path === 'src/server.js')).toEqual({ path: 'src/server.js', language: 'javascript', lines: 22, size: expect.any(Number) });
    expect(leaks(JSON.stringify(created))).toEqual([]);
    const stored = await Project.findById(created.id).lean();
    expect(leaks(JSON.stringify(stored))).toEqual([]);
    const excerpt = (await owner.get(`/api/projects/${created.id}/excerpt?path=src/server.js&start=1&end=5`).expect(200)).body.excerpt;
    expect(excerpt.text).toContain('[redacted AWS access key]');
    expect((await owner.get('/api/projects').expect(200)).body.projects[0].files).toBeUndefined();
    await other.get(`/api/projects/${created.id}`).expect(404);
    await owner.post('/api/projects').set('content-type', 'application/zip').set('x-project-name', 'x').send(Buffer.from('PK nope')).expect(415);
    await owner.post('/api/projects').set('content-type', 'application/zip').send(projectZip()).expect(400);
    await upload(owner, 'Two').expect(201); await upload(owner, 'Three').expect(201);
    expect((await upload(owner, 'Four').expect(409)).body.error).toMatch(/up to 3 projects/);
  });

  it('checks resume claims against the code, quoting the resume exactly', async () => {
    const project = (await upload(owner).expect(201)).body.project;
    const resume = (await owner.post('/api/documents').send({ kind: 'resume', title: 'My resume',
      text: 'Software engineer.\nBuilt a real-time chat app with Socket.IO and JWT login\nDeployed it on Kubernetes\n' }).expect(201)).body.document;
    const checked = (await owner.post(`/api/projects/${project.id}/claims`).send({ documentId: resume.id }).expect(201)).body.project.claimChecks[0];
    expect(checked).toMatchObject({ documentTitle: 'My resume', dropped: 1 });
    expect(checked.claims.map((c: any) => [c.quote, c.status])).toEqual([['Built a real-time chat app with Socket.IO and JWT login', 'supported'], ['Deployed it on Kubernetes', 'not_found']]);
    expect(leaks(ai.map(a => a.body).join('\n'))).toEqual([]);
    await owner.post(`/api/projects/${project.id}/claims`).send({ documentId: project.id }).expect(400);
  });

  it('runs a project-defense interview about real files and functions, then removes it with the project', async () => {
    const project = (await upload(owner).expect(201)).body.project;
    const base = { role: 'Backend Developer', type: 'Technical', difficulty: 'Intermediate', topic: 'Project: Chat app', totalQuestions: 3, mode: 'ai' };
    await owner.post('/api/interviews').send({ ...base, mode: 'practice', projectId: project.id }).expect(400);
    await owner.post('/api/interviews').send({ ...base, type: 'Behavioral', projectId: project.id }).expect(400);
    await other.post('/api/interviews').send({ ...base, projectId: project.id }).expect(400);
    const created = (await owner.post('/api/interviews').send({ ...base, projectId: project.id }).expect(201)).body.interview;
    // The model did not name the code in three tries, so the app added the reference.
    const first = created.currentQuestionGrounding.code;
    expect(created.currentQuestion).toBe(`In ${first.path} (${first.symbol.split(/::|\./).at(-1)}): Why did you design it this way?`);
    expect(first).toMatchObject({ projectId: project.id, referenced: 'added' });
    expect(created.currentQuestionGeneration.promptVersion).toBe('interviewer-project.v1');
    expect(ai.filter(a => a.input.target)).toHaveLength(3);
    nameTheCode = true;
    const seen = [first];
    for (const questionIndex of [0, 1, 2]) {
      await owner.post(`/api/interviews/${created._id}/answer`).send({ answer: 'It checks the token and returns 401 when it is invalid.', questionIndex, submissionId: `p-${questionIndex}` }).expect(202);
      await processNextInterviewJob();
      const doc = (await owner.get(`/api/interviews/${created._id}`).expect(200)).body.interview;
      if (doc.status === 'in_progress') { expect(doc.currentQuestionGrounding.code.referenced).toBe('model'); seen.push(doc.currentQuestionGrounding.code); }
    }
    // Every question refers to a real symbol in a real file, with its (redacted) code, and none repeats.
    const stored = await Project.findById(project.id).lean();
    for (const ref of seen) {
      expect(stored!.symbols.some(s => s.path === ref.path && s.name === ref.symbol)).toBe(true);
      expect(ref.excerpt.length).toBeGreaterThan(20);
    }
    expect(new Set(seen.map(r => `${r.path}#${r.symbol}`)).size).toBe(seen.length);
    const done = (await owner.get(`/api/interviews/${created._id}`).expect(200)).body.interview;
    expect(done.status).toBe('completed');
    const judge = ai.find(a => a.input.turns)!;
    expect(judge.input.turns[0].referenceCode).toMatchObject({ path: first.path });
    expect(done.feedback.generation.promptVersion).toBe('evidence-judge.v2+project');
    // Exit gate: no secret in any prompt or log line.
    expect(leaks(ai.map(a => a.body).join('\n'))).toEqual([]);
    expect(leaks(logged.join('\n'))).toEqual([]);
    await owner.delete(`/api/projects/${project.id}`).expect(200);
    const after = (await Interview.findById(created._id).lean())!;
    expect(after.projectId).toBeUndefined();
    expect(after.turns.every(t => t.question === REMOVED_QUESTION && !t.grounding)).toBe(true);
    await owner.get(`/api/projects/${project.id}`).expect(404);
  });

  it('asks again when a question names code that does not exist', async () => {
    const project = (await upload(owner).expect(201)).body.project;
    nameTheCode = true; invent = 1;
    const created = (await owner.post('/api/interviews').send({ role: 'Developer', type: 'Technical', difficulty: 'Intermediate', topic: 'Project: Chat app',
      totalQuestions: 2, mode: 'ai', projectId: project.id }).expect(201)).body.interview;
    expect(ai.filter(a => a.input.target)).toHaveLength(2);
    expect(created.currentQuestion).not.toContain('madeUpHelper');
    expect(created.currentQuestion).toMatch(/^Why does `.+` work this way\?$/);
    expect(created.currentQuestionGrounding.code.referenced).toBe('model');
  });
});
