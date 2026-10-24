import mongoose, { Schema } from 'mongoose';
const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  interviewId: { type: Schema.Types.ObjectId }, slot: String, provider: String, model: String,
  consentVersion: String, promptVersion: String, status: { type: String, enum: ['started', 'succeeded', 'failed', 'cancelled'], default: 'started' },
  inputTokens: { type: Number, default: null }, outputTokens: { type: Number, default: null },
  latencyMs: Number, failure: { type: String, enum: ['provider_error', 'invalid_output', 'consent_revoked'] },
}, { timestamps: true });
schema.index({ userId: 1, createdAt: -1 });
export const AIUsage = mongoose.model('AIUsage', schema);
