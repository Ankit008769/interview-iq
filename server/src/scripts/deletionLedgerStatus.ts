import mongoose from 'mongoose';
import { AccountDeletion } from '../models/Account.js';
import { User } from '../models/User.js';
import { ledgerBucket } from '../services/deletionLedger.js';

// Operator-only migration audit. No IDs, credentials or candidate content are logged.
async function main() {
  const bucket = ledgerBucket();
  if (!bucket || !process.env.MONGODB_URI) throw new Error('Missing configuration');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  try {
    const [total, replicated, pendingMarkers] = await Promise.all([
      AccountDeletion.countDocuments(),
      AccountDeletion.countDocuments({ replicatedAt: { $type: 'date' }, replicationBucket: bucket }),
      User.aggregate([
        { $match: { deletionRequestedAt: { $type: 'date' } } },
        { $lookup: { from: AccountDeletion.collection.name, localField: '_id', foreignField: 'userId', as: 'receipts' } },
        { $match: { 'receipts.0': { $exists: false } } }, { $count: 'count' },
      ]),
    ]);
    const markersWithoutReceipt = pendingMarkers[0]?.count ?? 0;
    console.log(JSON.stringify({ event: 'deletion_ledger_audit', total, replicated, pending: total - replicated, markersWithoutReceipt }));
    if (total !== replicated || markersWithoutReceipt) process.exitCode = 1;
  } finally { await mongoose.disconnect(); }
}
main().catch(() => { console.error('Deletion ledger audit failed. Check database access and configuration.'); process.exitCode = 1; });
