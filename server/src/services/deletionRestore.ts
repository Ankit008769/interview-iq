import { Storage } from '@google-cloud/storage';
import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';

export type DeletionReceipt = { version: 1; userId: string; requestedAt: string };
export function validateRestoreTarget(uri: string) {
  const target = new URL(uri);
  if (target.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
    || !/^\/[a-zA-Z0-9_-]+$/.test(target.pathname)) throw new Error('Restore must target an explicitly named loopback database');
}
export function parseReceipt(name: string, content: string): DeletionReceipt {
  const value = JSON.parse(content);
  if (!value || value.version !== 1 || !/^[a-f0-9]{24}$/.test(value.userId)
    || name !== `receipts/v1/${value.userId}.json`
    || typeof value.requestedAt !== 'string' || !Number.isFinite(Date.parse(value.requestedAt))
    || new Date(value.requestedAt).toISOString() !== value.requestedAt
    || Object.keys(value).sort().join(',') !== 'requestedAt,userId,version') throw new Error('Invalid deletion ledger entry');
  return value;
}
export async function readDeletionLedger(bucketName: string): Promise<DeletionReceipt[]> {
  const storage = new Storage({ retryOptions: { maxRetries: 2 } });
  const receipts: DeletionReceipt[] = [];
  // getFilesStream follows all pages. Any listing/download/validation failure
  // aborts before reconciliation; an incomplete export is never accepted.
  for await (const file of storage.bucket(bucketName).getFilesStream({ prefix: 'receipts/' })) {
    if (Number(file.metadata.size) > 4096) throw new Error('Oversized deletion receipt');
    const [content] = await file.download({ validation: 'crc32c' });
    receipts.push(parseReceipt(file.name, content.toString('utf8')));
  }
  if (!receipts.length) throw new Error('Empty ledger: verify the bucket and migration before promotion');
  return receipts;
}

export async function reconcileDeletions(db: Db, receipts: DeletionReceipt[]) {
  // Validate the whole input before any destructive operation.
  for (const receipt of receipts) parseReceipt(`receipts/v1/${receipt.userId}.json`, JSON.stringify(receipt));
  for (const receipt of receipts) await db.collection('accountdeletions').updateOne({ userId: new ObjectId(receipt.userId) },
    { $min: { requestedAt: new Date(receipt.requestedAt) }, $setOnInsert: { lastSweptAt: new Date(0) } }, { upsert: true });
  // Include pending markers in the restored snapshot and existing receipts.
  for await (const user of db.collection('users').find({ deletionRequestedAt: { $type: 'date' } })) {
    await db.collection('accountdeletions').updateOne({ userId: user._id },
      { $min: { requestedAt: user.deletionRequestedAt }, $setOnInsert: { lastSweptAt: new Date(0) } }, { upsert: true });
  }
  let suppressed = 0;
  for await (const receipt of db.collection('accountdeletions').find()) {
    const userId = receipt.userId;
    if (!(userId instanceof ObjectId)) throw new Error('Invalid local deletion receipt');
    for (const name of ['interviews', 'documents', 'skill_states', 'study_plans', 'code_runs', 'aiusages', 'authsessions', 'accounttokens']) await db.collection(name).deleteMany({ userId });
    await db.collection('quotabuckets').deleteMany({ _id: { $regex: `^${userId.toHexString()}:` } } as any);
    await db.collection('users').deleteOne({ _id: userId });
    suppressed++;
  }
  // A backup must not revive sessions or reset/verification links for ANY user.
  await db.collection('authsessions').deleteMany({});
  await db.collection('accounttokens').deleteMany({});
  return { receiptsLoaded: receipts.length, suppressed, sessionsRevoked: true };
}
