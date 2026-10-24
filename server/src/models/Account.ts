import mongoose, { Schema } from 'mongoose';
const sessionSchema = new Schema({
  tokenHash: { type: String, required: true, unique: true, select: false },
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  version: { type: Number, required: true }, expiresAt: { type: Date, required: true },
}, { timestamps: true });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const AuthSession = mongoose.model('AuthSession', sessionSchema);
const tokenSchema = new Schema({
  tokenHash: { type: String, required: true, unique: true, select: false },
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  purpose: { type: String, enum: ['reset', 'verify'], required: true },
  version: { type: Number, required: true }, expiresAt: { type: Date, required: true },
});
tokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const AccountToken = mongoose.model('AccountToken', tokenSchema);

// Minimal deletion receipts survive user cleanup, enabling repeated orphan sweeps
// and suppression of deleted accounts when restoring an older backup.
const deletionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  requestedAt: { type: Date, required: true },
  lastSweptAt: { type: Date, default: () => new Date(0), index: true },
});
export const AccountDeletion = mongoose.model('AccountDeletion', deletionSchema);
