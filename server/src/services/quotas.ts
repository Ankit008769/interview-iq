import mongoose, { Schema } from 'mongoose';

const quotaSchema = new Schema({
  _id: { type: String, required: true },
  used: { type: Number, required: true },
  expiresAt: { type: Date, required: true },
});
quotaSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const QuotaBucket = mongoose.model('QuotaBucket', quotaSchema);

export class QuotaError extends Error {
  constructor(public readonly resetAt: Date, public readonly kind: string) {
    super(`Your ${kind} limit has been reached. Try again after ${resetAt.toISOString()}.`);
  }
}

export function quotaLimit(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

// Fixed windows are shared across processes. Expiry cleanup is not used for enforcement.
export async function consumeQuota(userId: string, kind: string, limit: number, windowMs: number, now = new Date()) {
  const start = Math.floor(now.getTime() / windowMs) * windowMs;
  const resetAt = new Date(start + windowMs);
  const key = `${userId}:${kind}:${start}`;
  try {
    await QuotaBucket.updateOne({ _id: key }, { $setOnInsert: { used: 0,
      expiresAt: new Date(resetAt.getTime() + 86400_000) } }, { upsert: true });
  } catch (err: any) { if (err?.code !== 11000) throw err; }
  const bucket = await QuotaBucket.findOneAndUpdate({ _id: key, used: { $lt: limit } },
    { $inc: { used: 1 } }, { new: true });
  if (!bucket) throw new QuotaError(resetAt, kind);
  return { remaining: limit - bucket.used, resetAt };
}

export const consumeAIQuota = (userId: string) => consumeQuota(userId, 'AI processing', quotaLimit('AI_CALLS_PER_DAY', 100), 86400_000);
