import { ConsentRequiredError } from './services/providerConsent.js';
import { operationalEvent } from './services/monitoring.js';
import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/account.js';
import interviewRoutes from './routes/interviews.js';
import documentRoutes from './routes/documents.js';
import learningRoutes from './routes/learning.js';
import codingRoutes from './routes/coding.js';
import projectRoutes from './routes/projects.js';
import designRoutes from './routes/design.js';
import orgRoutes from './routes/orgs.js';
import billingRoutes, { webhooks as billingWebhooks } from './routes/billing.js';
import passportRoutes, { didRoute } from './routes/passport.js';
import { EntitlementError } from './billing/entitlements.js';
import { QuotaError } from './services/quotas.js';
import { interviewMode } from './services/ai.js';
import { localModelStatus, localVoiceStatus } from './services/modelProvider.js';

const origin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

export const app = express();
if (process.env.TRUST_PROXY_HOPS) {
  const hops = Number(process.env.TRUST_PROXY_HOPS);
  if (!Number.isInteger(hops) || hops < 0 || hops > 5) throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 5.');
  app.set('trust proxy', hops);
}
app.disable('x-powered-by');
// Video self-review compiles MediaPipe's WebAssembly in the browser and plays recordings from blob: URLs.
app.use(helmet({ contentSecurityPolicy: { directives: { scriptSrc: ["'self'", "'wasm-unsafe-eval'"], mediaSrc: ["'self'", 'blob:'] } } }));
app.use(cors({ origin, credentials: true }));
// Payment-provider webhooks are verified against their raw bodies, so they are routed before any JSON parsing.
app.use('/api/billing/webhooks', billingWebhooks);
// Design drafts carry drawings and parse their own larger body (routes/design.ts); everything else stays at 100 KB.
const jsonBody = express.json({ limit: '100kb' });
app.use((req, res, next) => (req.method === 'PUT' && /^\/api\/design\/sessions\/[^/]+\/draft$/.test(req.path) ? next() : jsonBody(req, res, next)));
app.use(cookieParser());
// With cookie authentication, reject cross-origin browser writes.
app.use((req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin && req.headers.origin !== origin) {
    res.status(403).json({ error: 'Cross-origin request rejected.' }); return;
  }
  next();
});
// Model readiness is reported for local models but does not change the status code: the database decides liveness.
app.get('/api/health', async (_req, res) => {
  const connected = mongoose.connection.readyState === 1;
  const [model, voice] = await Promise.all([localModelStatus(), localVoiceStatus()]);
  res.status(connected ? 200 : 503).json({ ok: connected, database: connected ? 'connected' : 'disconnected', aiMode: interviewMode(),
    ...(model ? { model } : {}), ...(voice ? { voice } : {}) });
});
app.use('/api/auth', authRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/interviews', interviewRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/learning', learningRoutes);
app.use('/api/coding', codingRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/design', designRoutes);
app.use('/api/orgs', orgRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/passport', passportRoutes);
// The skill passport issuer's DID document (did:web).
app.get('/.well-known/did.json', didRoute);
if (process.env.SERVE_CLIENT === 'true') {
  const clientDist = fileURLToPath(new URL('../../client/dist/', import.meta.url));
  app.use(express.static(clientDist));
  app.get(/^\/(?!api(?:\/|$)).*/, (_req, res) => res.sendFile(join(clientDist, 'index.html')));
}
app.use((_req, res) => { res.status(404).json({ error: 'Route not found.' }); });
const handler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof QuotaError) {
    res.setHeader('Retry-After', Math.max(1, Math.ceil((err.resetAt.getTime() - Date.now()) / 1000)));
    res.status(429).json({ error: err.message, code: 'QUOTA_EXCEEDED', resetAt: err.resetAt.toISOString() }); return;
  }
  if (err instanceof ConsentRequiredError) { res.status(409).json({error:err.message,code:'AI_CONSENT_REQUIRED'}); return; }
  if (err instanceof EntitlementError) { res.status(402).json({ error: err.message, code: 'PLAN_REQUIRED', plan: err.plan, capability: err.capability }); return; }
  // Oversized or malformed request bodies are client errors, not server faults.
  if (err?.type === 'entity.too.large') { res.status(413).json({ error: 'That upload is too large.' }); return; }
  if (err?.type === 'entity.parse.failed') { res.status(400).json({ error: 'The request body could not be read.' }); return; }
  operationalEvent('api_error', 'ERROR');
  res.status(500).json({ error: 'Request failed. Please retry; if it continues, check the backend logs.' });
};
app.use(handler);
