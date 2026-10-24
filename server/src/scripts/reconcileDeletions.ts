import { MongoClient } from 'mongodb';
import { readDeletionLedger, reconcileDeletions, validateRestoreTarget } from '../services/deletionRestore.js';

// Deliberately does not load .env or accept the application's MONGODB_URI.
async function main() {
  const uri = process.env.RESTORE_MONGODB_URI;
  const bucket = process.env.DELETION_LEDGER_BUCKET;
  if (process.argv.length !== 3 || process.argv[2] !== '--isolated-restore' || !uri || !bucket) throw new Error('Explicit isolated restore configuration required');
  validateRestoreTarget(uri);
  const receipts = await readDeletionLedger(bucket);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, directConnection: true });
  try {
    await client.connect();
    console.log(JSON.stringify(await reconcileDeletions(client.db(), receipts)));
  } finally { await client.close(); }
}
main().catch(() => { console.error('Deletion reconciliation failed. Do not promote this restore. Check isolated target, ledger access and validity.'); process.exitCode = 1; });
