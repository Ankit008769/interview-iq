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
import { QuotaError } from './services/quotas.js';
import { interviewMode } from './services/ai.js';

const origin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

export const app = express();
if (process.env.TRUST_PROXY_HOPS) {
  const hops = Number(process.env.TRUST_PROXY_HOPS);
  if (!Number.isInteger(hops) || hops < 0 || hops > 5) throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 5.');
  app.set('trust proxy', hops);
}
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin, credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
// With cookie authentication, reject cross-origin browser writes.
app.use((req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin && req.headers.origin !== origin) {
    res.status(403).json({ error: 'Cross-origin request rejected.' }); return;
  }
  next();
});
app.get('/api/health', (_req, res) => {
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({ ok: connected, database: connected ? 'connected' : 'disconnected', aiMode: interviewMode() });
});
app.use('/api/auth', authRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/interviews', interviewRoutes);
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
  // Oversized or malformed request bodies are client errors, not server faults.
  if (err?.type === 'entity.too.large') { res.status(413).json({ error: 'That upload is too large.' }); return; }
  if (err?.type === 'entity.parse.failed') { res.status(400).json({ error: 'The request body could not be read.' }); return; }
  operationalEvent('api_error', 'ERROR');
  res.status(500).json({ error: 'Request failed. Please retry; if it continues, check the backend logs.' });
};
app.use(handler);
