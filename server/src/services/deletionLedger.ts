import { Storage } from '@google-cloud/storage';
import { AccountDeletion } from '../models/Account.js';
import { operationalEvent } from './monitoring.js';

// ADC uses the Cloud Run service identity; no service-account keys are stored.
const storage = new Storage({ retryOptions: { autoRetry: false } });
export function ledgerBucket() {
  const bucket = process.env.DELETION_LEDGER_BUCKET?.trim();
  if (!bucket && process.env.NODE_ENV === 'production') throw new Error('Deletion ledger is required in production');
  if (bucket && !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)) throw new Error('Invalid deletion ledger bucket');
  return bucket;
}
export async function writeDeletionReceipt(userId: string, requestedAt: Date) {
  if (!/^[a-f0-9]{24}$/.test(userId) || !Number.isFinite(requestedAt.getTime())) throw new Error('Invalid deletion receipt');
  const bucket = ledgerBucket();
  if (!bucket) return false; // Local development only; never claim remote durability.
  const body = JSON.stringify({ version: 1, userId, requestedAt: requestedAt.toISOString() });
  try {
    await storage.bucket(bucket).file(`receipts/v1/${userId}.json`).save(body, {
      resumable: false, timeout: 5000, validation: 'crc32c',
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: { contentType: 'application/json', cacheControl: 'no-store' },
    });
  } catch (error) {
    // Stable per-user name, create-only identity and dedicated bucket make a
    // previously successful write safe to retry after a lost response.
    if ((error as { code?: number }).code !== 412) throw new Error('Deletion ledger unavailable');
  }
  return true;
}

export async function replicateDeletionReceipt(receipt: { _id: unknown; userId: { toString(): string }; requestedAt: Date; replicatedAt?: Date | null; replicationBucket?: string | null }, now = new Date()) {
  try {
    const bucket = ledgerBucket();
    if (receipt.replicatedAt && receipt.replicationBucket === bucket && bucket) return true;
    const replicated = await writeDeletionReceipt(receipt.userId.toString(), receipt.requestedAt);
    if (replicated) await AccountDeletion.updateOne({ _id: receipt._id }, {
      $set: { replicatedAt: now, replicationBucket: bucket }, $unset: { replicationRetryAt: 1 },
    });
    return true; // No remote ledger is permitted only in non-production development.
  } catch {
    await AccountDeletion.updateOne({ _id: receipt._id }, { $set: { replicationRetryAt: new Date(now.getTime() + 60_000) } });
    operationalEvent('deletion_ledger_failure', 'ERROR');
    return false;
  }
}
