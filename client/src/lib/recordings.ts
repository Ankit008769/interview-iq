import type { FramingSummary } from './framing';

// Video self-review recordings (roadmap D4) are kept only in this browser's IndexedDB. They are never
// uploaded, are deleted after RETENTION_DAYS, and can be deleted at any time from Results or Account.
export const RETENTION_DAYS = 14;
const DB = 'interviewiq-self-review', STORE = 'recordings';

export interface Recording {
  id: string;                 // `${interviewId}:${questionIndex}`
  interviewId: string; questionIndex: number; question: string;
  blob: Blob; mimeType: string; durationMs: number; createdAt: number;
  framing: FramingSummary;
}
export type RecordingInfo = Omit<Recording, 'blob'> & { bytes: number };

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('This browser cannot store recordings.')); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('interviewId', 'interviewId');
      store.createIndex('createdAt', 'createdAt');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open recording storage.'));
  });
}
async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Recording storage failed.'));
    });
  } finally { db.close(); }
}
const info = ({ blob, ...rest }: Recording): RecordingInfo => ({ ...rest, bytes: blob.size });

export const saveRecording = (r: Recording) => run('readwrite', s => s.put(r)).then(() => undefined);
export const getRecording = (id: string) => run<Recording>('readonly', s => s.get(id));
export const deleteRecording = (id: string) => run('readwrite', s => s.delete(id)).then(() => undefined);
export const deleteAllRecordings = () => run('readwrite', s => s.clear()).then(() => undefined);
export async function listRecordings(interviewId?: string): Promise<RecordingInfo[]> {
  const all = (await run<Recording[]>('readonly', s => (interviewId ? s.index('interviewId').getAll(interviewId) : s.getAll()))) ?? [];
  return all.map(info).sort((a, b) => a.interviewId.localeCompare(b.interviewId) || a.questionIndex - b.questionIndex);
}
// Called whenever the feature is used, so expired recordings never linger.
export async function purgeExpired(now = Date.now()) {
  const cutoff = now - RETENTION_DAYS * 86_400_000;
  const old = (await listRecordings()).filter(r => r.createdAt < cutoff);
  for (const r of old) await deleteRecording(r.id);
  return old.length;
}

// Per-device preferences, not account settings.
const PREFS = { camera: 'iq.selfReview.camera', avatar: 'iq.avatar' } as const;
export function getPref(name: keyof typeof PREFS) { try { return localStorage.getItem(PREFS[name]) === 'on'; } catch { return false; } }
export function setPref(name: keyof typeof PREFS, on: boolean) { try { localStorage.setItem(PREFS[name], on ? 'on' : 'off'); } catch { /* private mode */ } }
