import mongoose, { Schema } from 'mongoose';

// Opt-in and satisfaction signals for optional features (roadmap D4: "opt-in rate and satisfaction measured;
// feature kept only if it improves retention"). Only the feature, what happened and a 1–5 rating are stored;
// no video, image, landmark or framing data ever reaches the server. Kept for about 13 months.
export const FEATURES = ['video_review', 'avatar'] as const;
export type Feature = typeof FEATURES[number];
export interface IFeatureEvent { userId: mongoose.Types.ObjectId; feature: Feature; kind: 'enabled' | 'disabled' | 'rating'; rating?: number; createdAt: Date }
const featureEventSchema = new Schema<IFeatureEvent>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  feature: { type: String, enum: FEATURES, required: true },
  kind: { type: String, enum: ['enabled', 'disabled', 'rating'], required: true },
  rating: { type: Number, min: 1, max: 5 },
  createdAt: { type: Date, default: () => new Date() },
});
featureEventSchema.index({ userId: 1, feature: 1, createdAt: -1 });
featureEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 400 * 86_400 });
export const FeatureEvent = mongoose.model<IFeatureEvent>('FeatureEvent', featureEventSchema, 'feature_events');
