import { writeFileSync } from 'node:fs';
import mongoose from 'mongoose';
import { DESIGN_PROMPT_BY_ID } from '../design/prompts.js';
import { analyzeGraph, classify, type DesignGraph } from '../design/graph.js';
import { checkEstimates, referenceEstimates } from '../design/estimates.js';
import { askConstraint, reviewDesign } from '../design/coach.js';
import { concordance, spearman } from '../calibration/auto.js';
import { iccA1 } from '../calibration/stats.js';
import { providerConfig } from '../services/providerConfig.js';
import type { IDesignSession } from '../models/DesignSession.js';

// Operator check of the system-design reviewer (C3 exit gate) with local models, using no database: strong,
// medium and weak synthetic designs for seven prompts are reviewed by two independent judges. It reports
// whether each judge orders them by quality and how well the judges agree (ICC A,1; the roadmap asks for
// 0.65), and how often follow-up questions name the candidate's own components.
//   npm run design-check -- --judges qwen3.5:4b,gemma4:e2b [--out report.json] [--trace] [--skip-follow-ups] [--only prompt-id,...]
// --trace prints each quote that a judge scored but that is not in the candidate's text.
type Spec = { prompt: string; nodes: string[]; edges: [string, string, string?][]; notes: string[]; explanation: string; answers: [string, string] };
const STRONG: Spec[] = [
  { prompt: 'url-shortener', nodes: ['Mobile and web clients', 'Load balancer', 'Link API service', 'Redis cache', 'Postgres links table (sharded by id)', 'ID counter service', 'Kafka click events', 'Analytics worker'],
    edges: [['Mobile and web clients', 'Load balancer'], ['Load balancer', 'Link API service'], ['Link API service', 'Redis cache', 'read-through'], ['Link API service', 'Postgres links table (sharded by id)'],
      ['Link API service', 'ID counter service', 'ranges of ids'], ['Link API service', 'Kafka click events'], ['Kafka click events', 'Analytics worker']],
    notes: ['Short code = base62 of a 64-bit id; each service instance leases a range of 1,000 ids'],
    explanation: 'Redirects are about 60 times more frequent than creates, so hot links are served from Redis with a read-through cache and a 24-hour TTL; a cache miss reads Postgres by primary key. Ids come from leased counter ranges, so codes never collide and no coordination is needed per request. Postgres is sharded by id because lookups are always by id. If Redis fails, redirects fall back to Postgres replicas with higher latency, and the load balancer removes unhealthy API instances. Click events go to Kafka so analytics never slows down a redirect.',
    answers: ['I would add an expires_at column with an index and a nightly job that deletes expired rows in batches; Redis keys get the same TTL, and the API checks expiry on read so an expired link is never served even before cleanup.', 'The hot link is cached at the CDN edge for a few seconds and in Redis; request coalescing stops a stampede to Postgres, and the API rate-limits per client so one campaign cannot starve others.'] },
  { prompt: 'pastebin', nodes: ['Browser clients', 'CDN', 'Load balancer', 'Paste API', 'Object storage for paste bodies', 'Metadata DB (Postgres)', 'Redis cache', 'Expiry worker'],
    edges: [['Browser clients', 'CDN'], ['CDN', 'Load balancer'], ['Load balancer', 'Paste API'], ['Paste API', 'Object storage for paste bodies'], ['Paste API', 'Metadata DB (Postgres)'], ['Paste API', 'Redis cache'], ['Expiry worker', 'Metadata DB (Postgres)'], ['Expiry worker', 'Object storage for paste bodies']],
    notes: ['Bodies up to 1 MB in object storage; metadata row holds key, owner, expiry'],
    explanation: 'Paste bodies go to object storage because they are large and immutable, while small metadata lives in Postgres for listing and expiry queries. Public pastes are cached at the CDN with a short TTL and in Redis, since reads are five times writes. Writes are acknowledged only after both the body and metadata are stored, so a paste is never lost. An expiry worker deletes expired metadata and bodies in batches. Object storage is replicated across zones, so losing one zone does not lose pastes.',
    answers: ['Large pastes are uploaded directly to object storage with a signed URL in chunks, so the API servers do not stream 50 MB through memory; limits and quotas stop abuse.', 'Private pastes are never cached at the CDN; the API checks the access list in Postgres and serves them with signed, short-lived URLs.'] },
  { prompt: 'chat-app', nodes: ['Phone apps', 'Load balancer', 'WebSocket gateway', 'Chat service', 'Redis presence and routing', 'Cassandra message store', 'Kafka message log', 'Push notification service', 'Media object storage'],
    edges: [['Phone apps', 'Load balancer'], ['Load balancer', 'WebSocket gateway'], ['WebSocket gateway', 'Chat service'], ['Chat service', 'Redis presence and routing'], ['Chat service', 'Kafka message log'],
      ['Kafka message log', 'Cassandra message store'], ['Kafka message log', 'Push notification service'], ['Phone apps', 'Media object storage', 'direct upload']],
    notes: ['Messages partitioned by conversation id; each message has a per-conversation sequence number'],
    explanation: 'Clients keep a WebSocket to a gateway; Redis maps each online user to their gateway so the chat service can route a message in one hop. Every message is written to Kafka first, which gives durability and ordering per conversation, and consumers store it in Cassandra partitioned by conversation id for fast history reads. Offline users get a push notification and fetch missed messages by sequence number when they reconnect, so nothing is lost. Groups use fan-out on write for up to 500 members. If a gateway dies, clients reconnect to another and resync from their last sequence number.',
    answers: ['Messages stay in Cassandra; when the user returns after three days the app asks for everything after its last sequence number in pages, and the server marks them delivered.', 'Only clients hold the keys; the server stores and routes ciphertext, so search and previews must move to the device, and group keys are rotated when members leave.'] },
  { prompt: 'food-delivery', nodes: ['Customer app', 'Restaurant app', 'API gateway', 'Order service', 'Menu search (Elasticsearch)', 'Redis cache', 'Orders DB (Postgres)', 'Kafka order events', 'Payment provider', 'Push notifications', 'Delivery tracking service'],
    edges: [['Customer app', 'API gateway'], ['Restaurant app', 'API gateway'], ['API gateway', 'Order service'], ['API gateway', 'Menu search (Elasticsearch)'], ['Menu search (Elasticsearch)', 'Redis cache'],
      ['Order service', 'Orders DB (Postgres)'], ['Order service', 'Payment provider'], ['Order service', 'Kafka order events'], ['Kafka order events', 'Push notifications'], ['Kafka order events', 'Delivery tracking service']],
    notes: ['Order state machine: placed -> paid -> accepted -> picked up -> delivered; idempotency key per checkout'],
    explanation: 'Menus and search are read-heavy, so they are served from Elasticsearch with a Redis cache in front, while orders go to Postgres because payments and order states need transactions. Checkout uses an idempotency key so a retried request never creates two orders or two charges. Order events go through Kafka to notifications and tracking, so a slow restaurant app does not block checkout. If the payment provider times out, the order stays in pending payment and a reconciliation job checks its status before retrying. Dinner peaks are handled by autoscaling stateless services and caching menus.',
    answers: ['I would pre-scale the stateless services and Elasticsearch replicas before the match, cache popular menus longer, and queue order confirmations to restaurants so a spike does not overload Postgres.', 'Stock changes are published as events and update the search index within seconds; checkout re-checks availability in Postgres, so an order for an item that just went out of stock is rejected cleanly.'] },
  { prompt: 'ticket-booking', nodes: ['Users', 'CDN waiting room', 'Load balancer', 'Booking service', 'Redis seat holds', 'Seat inventory DB (Postgres)', 'Booking queue (Kafka)', 'Payment gateway'],
    edges: [['Users', 'CDN waiting room'], ['CDN waiting room', 'Load balancer'], ['Load balancer', 'Booking service'], ['Booking service', 'Redis seat holds'], ['Booking service', 'Booking queue (Kafka)'],
      ['Booking queue (Kafka)', 'Seat inventory DB (Postgres)'], ['Booking service', 'Payment gateway']],
    notes: ['Seat rows updated with SELECT ... FOR UPDATE SKIP LOCKED; holds expire after 10 minutes'],
    explanation: 'A virtual waiting room at the CDN admits users at the rate the booking service can handle, which keeps the rush fair and protects the database. Seats are held in Redis with a 10-minute TTL so a seat is reserved during payment, and the final booking is written to Postgres with row locks so a seat can never be sold twice. Booking requests are queued so bursts are absorbed instead of failing. If payment does not complete, the hold expires and the seat returns to inventory. Postgres has a synchronous replica so a primary failure does not lose bookings.',
    answers: ['The waiting room issues signed tokens in arrival order and admits a fixed number per second; everyone else sees their position instead of errors, and the booking queue smooths what gets through.', 'Bots are slowed with per-account and per-device rate limits, a challenge for suspicious traffic and a limit on bookings per account, enforced at the gateway before the booking service.'] },
  { prompt: 'notifications', nodes: ['Product teams', 'Notification API gateway', 'Notification service', 'Priority queues (Kafka)', 'Channel workers', 'Preferences DB (DynamoDB)', 'Redis dedup keys', 'SMS provider', 'Email provider', 'Push provider'],
    edges: [['Product teams', 'Notification API gateway'], ['Notification API gateway', 'Notification service'], ['Notification service', 'Preferences DB (DynamoDB)'], ['Notification service', 'Priority queues (Kafka)'],
      ['Priority queues (Kafka)', 'Channel workers'], ['Channel workers', 'Redis dedup keys'], ['Channel workers', 'SMS provider'], ['Channel workers', 'Email provider'], ['Channel workers', 'Push provider']],
    notes: ['Separate topics for critical and bulk; dedup key = team + user + message id'],
    explanation: 'The service checks preferences and quiet hours, then puts each notification on a critical or bulk Kafka topic so time-critical messages are never stuck behind marketing campaigns. Channel workers send through providers and record a dedup key in Redis, so retries after a crash do not send twice. Preferences live in DynamoDB because lookups are by user id at very high volume. Each channel has a fallback provider and retries with backoff; if a provider is down, messages wait in the queue rather than being lost.',
    answers: ['The campaign goes to the bulk topic and is sent by many workers in parallel at the providers\' rate limits; critical traffic keeps its own topic so it is unaffected.', 'Workers switch to the second SMS provider after errors pass a threshold; queued messages wait with their expiry so stale OTPs are dropped instead of sent late.'] },
  { prompt: 'leaderboard', nodes: ['Game clients', 'Load balancer', 'Score service', 'Redis sorted sets', 'Scores DB (Postgres)', 'Score events queue', 'Anti-cheat worker'],
    edges: [['Game clients', 'Load balancer'], ['Load balancer', 'Score service'], ['Score service', 'Score events queue'], ['Score events queue', 'Anti-cheat worker'], ['Anti-cheat worker', 'Redis sorted sets'], ['Anti-cheat worker', 'Scores DB (Postgres)'], ['Score service', 'Redis sorted sets', 'rank queries']],
    notes: ['One sorted set per board and week; ZREVRANK for rank, ZREVRANGE for neighbours'],
    explanation: 'Redis sorted sets give O(log n) score updates and rank queries, which fits the 50 ms target. Scores are validated by an anti-cheat worker before they reach the board, and every accepted score is also stored in Postgres, so the boards can be rebuilt if Redis is lost. Updates only raise a player\'s best score, so scores never go backwards. The global board is a single sorted set because 30 million members fit in memory; reads are served from replicas.',
    answers: ['Friends boards are computed on read: fetch the friends\' scores from a hash and sort them, since friend lists are small; caching the result for a minute keeps it cheap.', 'The queue absorbs the burst, and the anti-cheat worker rejects scores that are impossible for the time played and rate-limits each account, so fake scores never reach Redis.'] },
];
const sentences = (s: string) => s.match(/[^.!?]+[.!?]/g) ?? [s];
function graphOf(nodes: string[], edges: [string, string, string?][], notes: string[]): DesignGraph {
  return { nodes: nodes.map(label => ({ id: label, label, type: classify(label) })), edges: edges.filter(([a, b]) => nodes.includes(a) && nodes.includes(b)).map(([from, to, label]) => ({ from, to, ...(label ? { label } : {}) })),
    notes, danglingArrows: 0, unlabeledShapes: 0 };
}
function variant(spec: Spec, quality: 0 | 1 | 2): IDesignSession {
  const prompt = DESIGN_PROMPT_BY_ID.get(spec.prompt)!;
  const ref = Object.fromEntries(referenceEstimates(prompt).map(e => [e.id, e.value]));
  const nodes = quality === 2 ? spec.nodes : quality === 1 ? spec.nodes.slice(0, Math.ceil(spec.nodes.length / 2)) : [spec.nodes[0], 'Server', 'Database'];
  const edges: [string, string, string?][] = quality === 0 ? [[spec.nodes[0], 'Server'], ['Server', 'Database']] : spec.edges;
  const graph = graphOf(nodes, edges, quality === 2 ? spec.notes : []);
  const estimates = quality === 2 ? { writeQps: ref.writeQps, peakReadQps: ref.peakReadQps, storagePerYear: { value: ref.storagePerYear / 1e12, unit: 'TB' as const } }
    : quality === 1 ? { writeQps: ref.writeQps * 5, peakReadQps: ref.peakReadQps / 4 } : {};
  const explanation = quality === 2 ? spec.explanation : quality === 1 ? sentences(spec.explanation).slice(0, 2).join(' ').trim() : 'I would use a server and a database.';
  const answers = quality === 2 ? spec.answers : quality === 1 ? spec.answers.map(a => sentences(a)[0].trim()) : ['I am not sure.', 'Add more servers.'];
  return { userId: new mongoose.Types.ObjectId(), promptId: spec.prompt, status: 'submitted', scene: [], estimates, explanation, graph,
    analysis: analyzeGraph(graph, prompt), estimateCheck: checkEstimates(prompt, estimates),
    followUps: answers.map((answer, index) => ({ index, constraint: prompt.constraints[index], question: `${prompt.constraints[index]} How does your design change?`, referenced: 'added' as const, askedAt: new Date(), answer })),
    createdAt: new Date(), updatedAt: new Date() };
}

async function main() {
  const judges = (process.argv[process.argv.indexOf('--judges') + 1] ?? '').split(',').filter(Boolean);
  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : undefined;
  if (providerConfig().provider === 'practice' || judges.length < 1) throw new Error('Set AI_PROVIDER and pass --judges model[,model].');
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',') : null;
  const items = STRONG.filter(spec => !only || only.includes(spec.prompt)).flatMap(spec => ([2, 1, 0] as const).map(q => ({ id: `${spec.prompt}:${q}`, quality: q, spec, session: variant(spec, q) })));
  const scores: Record<string, Record<string, number>> = {};
  const unverified: Record<string, number> = {};
  const trace = process.argv.includes('--trace');
  for (const judge of judges) {
    process.env.JUDGE_MODEL = judge;
    scores[judge] = {};
    for (const item of items) {
      const started = Date.now();
      try {
        const review = await reviewDesign({ usageContext: undefined as never, prompt: DESIGN_PROMPT_BY_ID.get(item.spec.prompt)!, session: item.session });
        scores[judge][item.id] = Math.round(review.criteria.reduce((n, c) => n + (c.score ?? 0), 0) / review.criteria.length * 20);
        unverified[judge] = (unverified[judge] ?? 0) + review.unverified.length;
        console.log(`${judge} ${item.id} -> ${scores[judge][item.id]} (${((Date.now() - started) / 1000).toFixed(0)}s, ${review.criteria.filter(c => c.score === null).length} unrated, ${review.unverified.length} with an unverifiable quote)`);
        if (trace) for (const u of review.unverified) console.log(`  unverified ${u.criterionId}: ${JSON.stringify(u.quote)}`);
      } catch (err) { console.log(`${judge} ${item.id} failed: ${(err as Error).message}`); }
    }
  }
  const report: Record<string, unknown> = { items: items.length, judges: {} };
  for (const judge of judges) {
    const rated = items.filter(i => scores[judge][i.id] !== undefined);
    (report.judges as Record<string, unknown>)[judge] = { rated: rated.length, ordering: concordance(rated.map(i => i.quality), rated.map(i => scores[judge][i.id])),
      spearman: spearman(rated.map(i => i.quality), rated.map(i => scores[judge][i.id])), unverifiedQuotes: unverified[judge] ?? 0 };
  }
  if (judges.length > 1) {
    const both = items.filter(i => judges.every(j => scores[j][i.id] !== undefined));
    report.crossJudge = { items: both.length, icc: iccA1(both.map(i => [scores[judges[0]][i.id], scores[judges[1]][i.id]])) };
  }
  // Follow-up questions written by the interviewer model for the strong designs.
  if (!process.argv.includes('--skip-follow-ups')) {
    let named = 0;
    for (const spec of STRONG) {
      const asked = await askConstraint({ usageContext: undefined as never, prompt: DESIGN_PROMPT_BY_ID.get(spec.prompt)!, session: { ...variant(spec, 2), followUps: [] }, index: 0 });
      if (asked.referenced === 'model') named++;
      console.log(`follow-up ${spec.prompt} [${asked.referenced}]: ${asked.question}`);
    }
    report.followUps = { asked: STRONG.length, namedOwnComponents: named };
  }
  report.scores = scores;
  console.log(JSON.stringify({ ...report, scores: undefined }, null, 2));
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
}
main().catch(err => { console.error(err instanceof Error ? err.message : 'Design check failed.'); process.exitCode = 1; });
