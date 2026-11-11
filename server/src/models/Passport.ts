import mongoose, { Schema } from 'mongoose';

// Skill passport credentials (roadmap E4). The signed credential is stored as issued; revoking sets
// revokedAt and its bit in the public status list. publicId is the unguessable part of the share link.
export const ACHIEVEMENT_KINDS = ['interviews', 'skills', 'coding', 'design'] as const;
export type AchievementKind = typeof ACHIEVEMENT_KINDS[number];
export interface IPassportCredential {
  userId: mongoose.Types.ObjectId; publicId: string; statusIndex: number;
  kinds: AchievementKind[]; includeName: boolean;
  credential: Record<string, unknown>;
  issuedAt: Date; validUntil: Date; revokedAt?: Date;
  createdAt: Date; updatedAt: Date;
}
const schema = new Schema<IPassportCredential>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  publicId: { type: String, required: true, unique: true },
  statusIndex: { type: Number, required: true, unique: true },
  kinds: { type: [String], enum: ACHIEVEMENT_KINDS, required: true },
  includeName: { type: Boolean, default: false },
  credential: { type: Schema.Types.Mixed, required: true },
  issuedAt: { type: Date, required: true }, validUntil: { type: Date, required: true }, revokedAt: Date,
}, { timestamps: true, minimize: false });
export const PassportCredential = mongoose.model<IPassportCredential>('PassportCredential', schema, 'passport_credentials');
