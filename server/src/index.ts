import 'dotenv/config';
import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import mongoose from 'mongoose';
import authRoutes from './routes/auth.js';
import interviewRoutes from './routes/interviews.js';

const port = Number(process.env.PORT || 5000);
const origin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
if (!process.env.MONGODB_URI) throw new Error('Missing MONGODB_URI. See server/.env.example');
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters.');
const app = express();
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
app.get('/api/health', (_req, res) => res.json({ ok: true, database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', aiMode: process.env.OPENAI_API_KEY ? 'ai' : 'practice' }));
app.use('/api/auth', authRoutes);
app.use('/api/interviews', interviewRoutes);
app.use((_req, res) => { res.status(404).json({ error: 'Route not found.' }); });
const handler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error('[API]', err);
  res.status(500).json({ error: 'Request failed. Please retry; if it continues, check the backend logs.' });
};
app.use(handler);
try {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  app.listen(port, () => console.log(`InterviewIQ API running on http://localhost:${port} (${process.env.OPENAI_API_KEY ? 'AI' : 'practice'} mode)`));
} catch (err) {
  console.error('Database connection failed:', err);
  process.exit(1);
}
