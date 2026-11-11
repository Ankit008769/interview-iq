import mongoose from 'mongoose';
import { featureReport } from '../services/featureReport.js';

// Operator report for optional features (D4 exit gate): npm run feature-report -- [--days 30]
async function main() {
  if (!process.env.MONGODB_URI) throw new Error('Missing configuration');
  const days = process.argv.includes('--days') ? Number(process.argv[process.argv.indexOf('--days') + 1]) : 30;
  if (!Number.isInteger(days) || days < 7 || days > 400) throw new Error('--days must be 7 to 400');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  try { console.log(JSON.stringify(await featureReport(days), null, 2)); } finally { await mongoose.disconnect(); }
}
main().catch(err => { console.error(err instanceof Error && /configuration|--days/.test(err.message) ? err.message : 'Feature report failed. Check database access.'); process.exitCode = 1; });
