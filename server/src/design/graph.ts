import type { ComponentType, DesignPrompt, Expected } from './prompts.js';

// Reads an Excalidraw scene as a component graph (roadmap C3): labelled shapes are components, arrows between
// them are connections, other text is notes. Done by the app, not the model, so the interviewer and the
// candidate see the same interpretation of the drawing.
export type DesignNode = { id: string; label: string; type: ComponentType };
export type DesignEdge = { from: string; to: string; label?: string };
export type DesignGraph = { nodes: DesignNode[]; edges: DesignEdge[]; notes: string[]; danglingArrows: number; unlabeledShapes: number };

// Order matters: the first match wins, so "Redis cache" is a cache and "search service" is search. Plurals match too.
const KEYWORDS: [ComponentType, RegExp][] = [
  ['cdn', /\b(cdn|edge cache|edge)s?\b/],
  ['load_balancer', /\b(load ?balancer|lb|nginx|haproxy|elb|alb)s?\b/],
  ['gateway', /\b(api ?gateway|gateway|ingress|bff)s?\b/],
  ['cache', /\b(cache|redis|memcached?|in-memory)s?\b/],
  ['queue', /\b(queue|kafka|rabbit ?mq|sqs|pub ?\/? ?sub|stream|kinesis|event bus|message broker|nats)s?\b/],
  ['search', /\b(search|elastic ?search|open ?search|solr|inverted index)s?\b/],
  ['object_storage', /\b(s3|blob|object (store|storage)|gcs|bucket|file storage|media storage)s?\b/],
  ['sql_db', /\b(postgres(ql)?|mysql|maria ?db|sql|rds|aurora|relational|oracle|spanner|cockroach)s?\b/],
  ['nosql_db', /\b(mongo(db)?|cassandra|dynamo(db)?|nosql|bigtable|hbase|key.?value|kv store|scylla|time.?series|tsdb|influx|document (db|store))s?\b/],
  ['database', /\b(db|database|data ?store|storage|ledger)s?\b/],
  ['realtime', /\b(web ?sockets?|socket|sse|long.?poll|realtime|real-time|presence)s?\b/],
  ['notification', /\b(push|notification|notifier|fcm|apns|sms|email sender|mailer)s?\b/],
  ['external', /\b(payment (gateway|provider)|bank|third.?party|external|partner|provider|maps api)s?\b/],
  ['monitoring', /\b(monitor(ing)?|metrics|logging|logs|alert(ing)?|tracing|prometheus|grafana)s?\b/],
  ['worker', /\b(worker|consumer|job|processor|cron|scheduler|transcoder|encoder|batch|pipeline)s?\b/],
  ['client', /\b(client|users?|browser|mobile|app|web ?app|android|ios|frontend|viewer|rider|driver|customer)s?\b/],
  ['service', /\b(service|server|api|backend|microservice|application|app server|handler|matcher|engine)s?\b/],
];
export const classify = (label: string): ComponentType => KEYWORDS.find(([, re]) => re.test(label.toLowerCase()))?.[0] ?? 'other';

type El = { id?: string; type?: string; isDeleted?: boolean; x?: number; y?: number; width?: number; height?: number; text?: string; originalText?: string;
  containerId?: string | null; points?: [number, number][]; startBinding?: { elementId?: string } | null; endBinding?: { elementId?: string } | null };
const SHAPES = new Set(['rectangle', 'ellipse', 'diamond']);
const clean = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 120);

export function sceneToGraph(elements: unknown[]): DesignGraph {
  const live = (elements as El[]).filter(e => e && typeof e === 'object' && !e.isDeleted && typeof e.id === 'string');
  const shapes = live.filter(e => SHAPES.has(e.type ?? ''));
  const texts = live.filter(e => e.type === 'text' && clean(e.originalText ?? e.text ?? ''));
  const labels = new Map<string, string>();
  const notes: string[] = [];
  const inside = (s: El, x: number, y: number, margin = 0) => x >= (s.x ?? 0) - margin && x <= (s.x ?? 0) + (s.width ?? 0) + margin && y >= (s.y ?? 0) - margin && y <= (s.y ?? 0) + (s.height ?? 0) + margin;
  for (const t of texts) {
    const text = clean(t.originalText ?? t.text ?? '');
    if (t.containerId) { labels.set(t.containerId, labels.has(t.containerId) ? `${labels.get(t.containerId)} ${text}` : text); continue; }
    // Text typed on top of a shape without binding still labels it.
    const cx = (t.x ?? 0) + (t.width ?? 0) / 2, cy = (t.y ?? 0) + (t.height ?? 0) / 2;
    const host = shapes.find(s => inside(s, cx, cy) && !labels.has(s.id!));
    if (host) labels.set(host.id!, text); else notes.push(text);
  }
  const nodes: DesignNode[] = [];
  let unlabeledShapes = 0;
  for (const s of shapes) {
    const label = labels.get(s.id!);
    if (!label) { unlabeledShapes++; continue; }
    nodes.push({ id: s.id!, label, type: classify(label) });
  }
  const ids = new Set(nodes.map(n => n.id));
  // An arrow's end attaches to the shape it is bound to, or failing that to the shape its end point is over.
  const attach = (arrow: El, end: 'start' | 'end') => {
    const bound = (end === 'start' ? arrow.startBinding : arrow.endBinding)?.elementId;
    if (bound && ids.has(bound)) return bound;
    const points = arrow.points ?? [];
    const p = end === 'start' ? points[0] : points.at(-1);
    if (!p) return undefined;
    const x = (arrow.x ?? 0) + p[0], y = (arrow.y ?? 0) + p[1];
    return nodes.find(n => inside(shapes.find(s => s.id === n.id)!, x, y, 24))?.id;
  };
  const edges: DesignEdge[] = [];
  let danglingArrows = 0;
  for (const a of live.filter(e => e.type === 'arrow' || e.type === 'line')) {
    const from = attach(a, 'start'), to = attach(a, 'end');
    if (!from || !to || from === to) { danglingArrows++; continue; }
    const label = labels.get(a.id!);
    if (!edges.some(e => e.from === from && e.to === to && e.label === label)) edges.push({ from, to, ...(label ? { label } : {}) });
  }
  return { nodes, edges, notes: notes.slice(0, 50), danglingArrows, unlabeledShapes };
}

const satisfies = (expected: Expected, type: ComponentType) => expected === type
  || (expected === 'database' && (type === 'sql_db' || type === 'nosql_db'))
  || ((expected === 'sql_db' || expected === 'nosql_db') && type === 'database');
export const TYPE_LABELS: Record<ComponentType, string> = { client: 'client', cdn: 'CDN', load_balancer: 'load balancer', gateway: 'API gateway', service: 'service',
  worker: 'background worker', cache: 'cache', sql_db: 'relational database', nosql_db: 'NoSQL database', database: 'database', queue: 'queue or stream',
  object_storage: 'object storage', search: 'search index', realtime: 'real-time connection', notification: 'notifications', external: 'external provider',
  monitoring: 'monitoring', other: 'other' };

// Facts about the drawing compared with what such a design usually needs. Observations, not a score.
export function analyzeGraph(graph: DesignGraph, prompt: DesignPrompt) {
  const types = graph.nodes.map(n => n.type);
  const present = prompt.expected.filter(e => types.some(t => satisfies(e, t)));
  const missing = prompt.expected.filter(e => !present.includes(e));
  const connected = new Set(graph.edges.flatMap(e => [e.from, e.to]));
  const isolated = graph.nodes.filter(n => !connected.has(n.id)).map(n => n.label);
  const observations: string[] = [];
  if (!graph.nodes.length) observations.push('No labelled components were found. Draw boxes and type a name inside each one.');
  if (graph.nodes.length && !types.includes('client')) observations.push('The diagram does not show where requests come from (a client or users).');
  if (graph.nodes.length && !graph.edges.length) observations.push('No connections were found. Draw arrows from one box to another.');
  if (isolated.length) observations.push(`Not connected to anything: ${isolated.slice(0, 6).join(', ')}.`);
  if (graph.danglingArrows) observations.push(`${graph.danglingArrows} arrow${graph.danglingArrows === 1 ? ' does' : 's do'} not connect two labelled boxes.`);
  if (graph.unlabeledShapes) observations.push(`${graph.unlabeledShapes} box${graph.unlabeledShapes === 1 ? ' has' : 'es have'} no label.`);
  if (types.includes('database') && (prompt.expected.includes('sql_db') || prompt.expected.includes('nosql_db'))) observations.push('A database is shown without its kind; say whether it is relational or NoSQL and why.');
  if (missing.length) observations.push(`Designs for this problem usually include: ${missing.map(m => TYPE_LABELS[m]).join(', ')}.`);
  return { present, missing, isolated, observations };
}
