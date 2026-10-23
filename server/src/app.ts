import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import authRoutes from './routes/auth.js';
import interviewRoutes from './routes/interviews.js';
import { QuotaError } from './services/quotas.js';

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
  res.status(connected ? 200 : 503).json({ ok: connected, database: connected ? 'connected' : 'disconnected', aiMode: process.env.OPENAI_API_KEY ? 'ai' : 'practice' });
});
app.use('/api/auth', authRoutes);
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
  console.error('[API]', err);
  res.status(500).json({ error: 'Request failed. Please retry; if it continues, check the backend logs.' });
};
app.use(handler);
