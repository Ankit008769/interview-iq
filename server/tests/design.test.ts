import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { DesignSession, sanitizeScene } from '../src/models/DesignSession.js';
import { DESIGN_PROMPTS, DESIGN_PROMPT_BY_ID } from '../src/design/prompts.js';
import { analyzeGraph, classify, sceneToGraph } from '../src/design/graph.js';
import { checkEstimates, referenceEstimates, scaleCard } from '../src/design/estimates.js';

process.env.JWT_SECRET = 'design-test-secret-longer-than-thirty-two-characters';
const { app } = await import('../src/app.js');

// A small Excalidraw scene: bound labels, a label typed on top of a box, bound arrows, an unbound arrow whose
// ends sit over two boxes, a dangling arrow, an unlabelled box and a free note.
const box = (id: string, x: number, y: number, label?: string, bound = true) => [
  { id, type: 'rectangle', x, y, width: 160, height: 80, boundElements: label && bound ? [{ id: `${id}-t`, type: 'text' }] : [] },
  ...(label ? [{ id: `${id}-t`, type: 'text', x: x + 10, y: y + 30, width: 140, height: 20, text: label, originalText: label, containerId: bound ? id : null }] : []),
];
const arrow = (id: string, from: string | null, to: string | null, x: number, y: number, dx: number, dy: number) =>
  ({ id, type: 'arrow', x, y, points: [[0, 0], [dx, dy]], startBinding: from ? { elementId: from } : null, endBinding: to ? { elementId: to } : null });
const SCENE = [
  ...box('client', 0, 0, 'Mobile app'), ...box('lb', 300, 0, 'Load balancer'), ...box('api', 600, 0, 'Link service'),
  ...box('cache', 600, 200, 'Redis cache'), ...box('db', 900, 200, 'Postgres links table'), ...box('q', 900, 0, 'Kafka click events', false),
  ...box('blank', 0, 400),
  arrow('a1', 'client', 'lb', 160, 40, 140, 0), arrow('a2', 'lb', 'api', 460, 40, 140, 0), arrow('a3', 'api', 'cache', 680, 80, 0, 120),
  arrow('a4', null, null, 760, 60, 200, 180), // unbound, from Link service to Postgres by position
  arrow('a5', 'api', null, 760, 20, 60, -300), // goes nowhere
  { id: 'a3-label', type: 'text', x: 690, y: 120, width: 60, height: 20, text: 'read-through', originalText: 'read-through', containerId: 'a3' },
  { id: 'note', type: 'text', x: 0, y: 600, width: 300, height: 20, text: 'IDs are base62 of a counter', originalText: 'IDs are base62 of a counter' },
  { id: 'gone', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, isDeleted: true },
];

describe('prompts, estimates and the drawing', () => {
  it('has 30 complete prompts whose estimates follow from the scale card', () => {
    expect(DESIGN_PROMPTS).toHaveLength(30);
    expect(new Set(DESIGN_PROMPTS.map(p => p.id)).size).toBe(30);
    for (const p of DESIGN_PROMPTS) {
      expect(p.functional.length, p.id).toBeGreaterThanOrEqual(3);
      expect(p.constraints, p.id).toHaveLength(3);
      expect(p.expected.length, p.id).toBeGreaterThanOrEqual(3);
      for (const e of referenceEstimates(p)) expect(e.value, `${p.id} ${e.id}`).toBeGreaterThan(0);
      expect(scaleCard(p)).not.toMatch(/undefined|NaN/);
    }
    const url = DESIGN_PROMPT_BY_ID.get('url-shortener')!;
    expect(scaleCard(url)).toBe('20 million daily active users. Per day, each accounts for about 0.5 links created and 10 redirects. Each of the links created stores about 0.5 KB. Peak traffic is 3 times the daily average.');
    expect(referenceEstimates(url).map(e => Math.round(e.value))).toEqual([116, 6944, 1825000000000]);
  });

  it('judges estimates by how many times off they are', () => {
    const url = DESIGN_PROMPT_BY_ID.get('url-shortener')!;
    const check = checkEstimates(url, { writeQps: 100, peakReadQps: 1000, storagePerYear: { value: 50, unit: 'TB' } });
    expect(check.map(c => c.verdict)).toEqual(['close', 'order_of_magnitude', 'off']);
    expect(check[2].formula).toContain('1.8 TB');
    expect(checkEstimates(url, {}).every(c => c.verdict === 'missing' && c.given === null)).toBe(true);
    expect(checkEstimates(url, { writeQps: -5 })[0].verdict).toBe('missing');
  });

  it('reads labelled boxes and arrows as a component graph, the way the candidate drew it', () => {
    const graph = sceneToGraph(SCENE);
    expect(graph.nodes.map(n => [n.label, n.type])).toEqual([['Mobile app', 'client'], ['Load balancer', 'load_balancer'], ['Link service', 'service'],
      ['Redis cache', 'cache'], ['Postgres links table', 'sql_db'], ['Kafka click events', 'queue']]);
    expect(graph.edges).toEqual([{ from: 'client', to: 'lb' }, { from: 'lb', to: 'api' }, { from: 'api', to: 'cache', label: 'read-through' }, { from: 'api', to: 'db' }]);
    expect(graph).toMatchObject({ notes: ['IDs are base62 of a counter'], danglingArrows: 1, unlabeledShapes: 1 });
    const analysis = analyzeGraph(graph, DESIGN_PROMPT_BY_ID.get('url-shortener')!);
    expect(analysis).toMatchObject({ missing: [], isolated: ['Kafka click events'] });
    expect(analysis.observations).toEqual(['Not connected to anything: Kafka click events.', '1 arrow does not connect two labelled boxes.', '1 box has no label.']);
    expect(analyzeGraph(sceneToGraph([]), DESIGN_PROMPT_BY_ID.get('chat-app')!).observations[0]).toMatch(/No labelled components/);
    expect(['Users', 'CDN edge', 'API Gateway', 'MongoDB', 'S3 bucket', 'Elasticsearch', 'WebSocket server', 'FCM push', 'Transcoding workers', 'Main DB', 'Thing']
      .map(classify)).toEqual(['client', 'cdn', 'gateway', 'nosql_db', 'object_storage', 'search', 'realtime', 'notification', 'worker', 'database', 'other']);
  });

  it('keeps only drawing elements and their drawing fields', () => {
    const cleaned = sanitizeScene([{ id: 'i', type: 'image', fileId: 'f' }, { id: 'e', type: 'embeddable', link: 'https://x' }, { id: 'd', type: 'rectangle', isDeleted: true },
      { id: 't', type: 'text', text: 'x'.repeat(900), customData: { secret: 1 }, link: 'https://evil.example' }, 'junk', null]);
    expect(cleaned).toEqual([{ id: 't', type: 'text', text: 'x'.repeat(500) }]);
  });
});

describe('design sessions API', () => {
  const ai: { system: string; input: any }[] = [];
  let questionReplies: string[] = [];
  const gateway = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body); const input = JSON.parse(parsed.messages[1].content);
    ai.push({ system: parsed.messages[0].content, input });
    // The review, then (for scored criteria without a verifiable quote) the quote request, then questions.
    const value = input.rubric ? { summary: 'A clear read-heavy design; failure handling is thin.', criteria: [
        { criterionId: 'requirements', score: 4, quote: 'IDs are base62 of a counter', rationale: 'States the ID scheme.', improvement: 'State the expiry rule.' },
        { criterionId: 'architecture', score: 4, quote: 'Link service -> Redis cache', rationale: 'Clear path.', improvement: null },
        { criterionId: 'data', score: 3, quote: 'Postgres links table', rationale: 'Relational store chosen.', improvement: 'Explain sharding.' },
        { criterionId: 'scale', score: 4, quote: null, rationale: 'Caches reads.', improvement: null },
        { criterionId: 'reliability', score: 3, quote: 'This sentence was never written', rationale: 'Invented.', improvement: 'x' },
        { criterionId: 'tradeoffs', score: 4, quote: 'a TTL column and a nightly cleanup job', rationale: 'Weighs cleanup.', improvement: null }] }
      : input.criteria ? { quotes: [{ criterionId: 'scale', quote: 'cache hot links in Redis' }, { criterionId: 'reliability', quote: 'Still not written anywhere' }] }
      : { question: questionReplies.shift() ?? 'What changes?' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model: parsed.model,
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(value), refusal: null }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  let mongo: MongoMemoryServer;
  const owner = request.agent(app), other = request.agent(app);
  beforeAll(async () => {
    await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
    vi.stubEnv('AI_PROVIDER', 'compatible'); vi.stubEnv('LLM_BASE_URL', `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`);
    vi.stubEnv('INTERVIEWER_MODEL', 'iq-interviewer'); vi.stubEnv('JUDGE_MODEL', 'iq-judge'); vi.stubEnv('INTERVIEW_WRITES_PER_15_MIN', '500');
    mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
    for (const [agent, email] of [[owner, 'designer@example.test'], [other, 'other-designer@example.test']] as const) {
      await agent.post('/api/auth/register').send({ name: 'Designer', email, password: 'test-password' }).expect(201);
    }
  }, 120_000);
  beforeEach(async () => { ai.length = 0; questionReplies = []; await DesignSession.deleteMany({}); });
  afterAll(async () => { vi.unstubAllEnvs(); await mongoose.disconnect(); await mongo?.stop(); gateway.close(); });

  it('lists prompts and shows requirement cards without giving the answers away', async () => {
    const list = (await owner.get('/api/design/prompts').expect(200)).body.prompts;
    expect(list).toHaveLength(30);
    const detail = (await owner.get('/api/design/prompts/url-shortener').expect(200)).body.prompt;
    expect(detail.estimates.map((e: any) => e.label)).toEqual(['Average links created per second', 'Peak redirects per second', 'New storage per year']);
    expect(JSON.stringify(detail)).not.toMatch(/"value"|formula|expected|tradeoffs|constraints/);
    await owner.get('/api/design/prompts/nope').expect(404);
    await request(app).get('/api/design/prompts').expect(401);
  });

  it('saves a large drawing, submits it, asks two grounded follow-ups and reviews with verified quotes', async () => {
    const session = (await owner.post('/api/design/sessions').send({ promptId: 'url-shortener' }).expect(201)).body.session;
    // Drafts may be larger than the 100 KB limit elsewhere.
    const padding = Array.from({ length: 600 }, (_, i) => ({ id: `n${i}`, type: 'freedraw', x: i, y: 0, points: Array.from({ length: 40 }, (_, k) => [k, k]) }));
    expect(JSON.stringify([...SCENE, ...padding]).length).toBeGreaterThan(100_000);
    const saved = (await owner.put(`/api/design/sessions/${session.id}/draft`).send({ scene: [...SCENE, ...padding],
      explanation: 'Reads dominate, so I cache hot links in Redis. Links expire via a TTL column and a nightly cleanup job.',
      estimates: { writeQps: 120, peakReadQps: 7000, storagePerYear: { value: 2, unit: 'TB' } } }).expect(200)).body.session;
    expect(saved.status).toBe('drafting');
    await other.put(`/api/design/sessions/${session.id}/draft`).send({ explanation: 'x' }).expect(404);
    const submitted = (await owner.post(`/api/design/sessions/${session.id}/submit`).expect(200)).body;
    expect(submitted.session.graph.nodes).toHaveLength(6);
    expect(submitted.session.estimateCheck.map((e: any) => e.verdict)).toEqual(['close', 'close', 'close']);
    expect(submitted.expected).toEqual(['load_balancer', 'service', 'cache', 'database']);
    await owner.put(`/api/design/sessions/${session.id}/draft`).send({ explanation: 'too late' }).expect(409);

    expect((await owner.post(`/api/design/sessions/${session.id}/follow-ups`).send({}).expect(409)).body.code).toBe('AI_CONSENT_REQUIRED');
    const { disclosure } = (await owner.get('/api/account/ai-consent').expect(200)).body;
    expect(disclosure.design).toMatch(/labels and arrows of your diagram/);
    await owner.post('/api/account/ai-consent').send({ version: disclosure.version, accepted: true }).expect(200);

    // First reply names no component and the second cites an invented one; the third is grounded.
    questionReplies = ['How would you handle expiry at scale?', 'Expiry is now 30 days: how does your `Expiry daemon` cope?', 'Links now expire after 30 days: what changes in your `Postgres links table` and `Redis cache`?'];
    const first = (await owner.post(`/api/design/sessions/${session.id}/follow-ups`).send({}).expect(201)).body.session.followUps[0];
    expect(first).toMatchObject({ index: 0, referenced: 'model', constraint: DESIGN_PROMPT_BY_ID.get('url-shortener')!.constraints[0] });
    expect(first.question).toContain('`Postgres links table`');
    expect(ai).toHaveLength(3);
    expect(ai[0].input.design.components).toEqual(expect.arrayContaining([{ label: 'Redis cache', kind: 'cache' }]));
    expect(JSON.stringify(ai[0].input)).not.toContain('freedraw');
    // A second question waits for an answer to the first.
    expect((await owner.post(`/api/design/sessions/${session.id}/follow-ups`).send({}).expect(200)).body.replayed).toBe(true);
    await owner.post(`/api/design/sessions/${session.id}/follow-ups/0/answer`).send({ answer: 'short' }).expect(400);
    await owner.post(`/api/design/sessions/${session.id}/follow-ups/0/answer`).send({ answer: 'Add an expires_at index and let Redis keys share the TTL.' }).expect(200);
    await owner.post(`/api/design/sessions/${session.id}/follow-ups/0/answer`).send({ answer: 'A different answer later on.' }).expect(409);
    await owner.post(`/api/design/sessions/${session.id}/follow-ups/0/rating`).send({ rating: 6 }).expect(400);
    await owner.post(`/api/design/sessions/${session.id}/follow-ups/0/rating`).send({ rating: 5 }).expect(200);
    questionReplies = ['No component here.', 'Still nothing.', 'Nothing again.'];
    const second = (await owner.post(`/api/design/sessions/${session.id}/follow-ups`).send({}).expect(201)).body.session.followUps[1];
    expect(second).toMatchObject({ referenced: 'added', question: `${DESIGN_PROMPT_BY_ID.get('url-shortener')!.constraints[1]} How would your design change to handle this?` });
    expect((await owner.post(`/api/design/sessions/${session.id}/review`).send({}).expect(409)).body.error).toMatch(/both follow-up/);
    await owner.post(`/api/design/sessions/${session.id}/follow-ups/1/answer`).send({ answer: 'Put the hot link on the CDN and rate-limit per client.' }).expect(200);
    await owner.post(`/api/design/sessions/${session.id}/follow-ups`).send({}).expect(409);

    const reviewed = (await owner.post(`/api/design/sessions/${session.id}/review`).send({}).expect(201)).body.session;
    expect(reviewed.status).toBe('reviewed');
    const criteria = reviewed.review.criteria;
    expect(criteria.map((c: any) => [c.criterionId, c.score])).toEqual([['requirements', 4], ['architecture', 4], ['data', 3], ['scale', 4], ['reliability', null], ['tradeoffs', 4]]);
    expect(ai.at(-2)!.input.candidateText).toContain('Answer 2: Put the hot link on the CDN');
    // Scale was scored without a quote and gets one from the quote request; reliability's quote is still invented.
    expect(ai.at(-1)!.input.criteria.map((c: any) => c.criterionId)).toEqual(['scale', 'reliability']);
    expect(criteria.find((c: any) => c.criterionId === 'scale').evidence.quote).toBe('cache hot links in Redis');
    expect((await owner.post(`/api/design/sessions/${session.id}/review`).send({}).expect(200)).body.replayed).toBe(true);
    expect((await owner.get('/api/design/prompts').expect(200)).body.prompts.find((p: any) => p.id === 'url-shortener')).toMatchObject({ sessions: 1, reviewed: true });
    await other.get(`/api/design/sessions/${session.id}`).expect(404);
    const exported = (await owner.get('/api/account/export').expect(200)).body;
    expect(exported.designSessions).toHaveLength(1);
  });

  it('refuses an empty submission and keeps other requests at the normal body limit', async () => {
    const session = (await owner.post('/api/design/sessions').send({ promptId: 'pastebin' }).expect(201)).body.session;
    expect((await owner.post(`/api/design/sessions/${session.id}/submit`).expect(400)).body.error).toMatch(/at least one labelled component/);
    await owner.post('/api/design/sessions').send({ promptId: 'x'.repeat(200_000) }).expect(413);
    await owner.post('/api/design/sessions').send({ promptId: 'unknown' }).expect(400);
  });
});
