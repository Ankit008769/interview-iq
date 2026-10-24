import mongoose, { Schema } from 'mongoose';

export interface IUser {
  name: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
  authVersion: number;
  aiConsent?: { version: string; acceptedAt: Date; provider: string; endpoint: string };
  emailVerifiedAt?: Date;
  deletionRequestedAt?: Date;
}

const userSchema = new Schema<IUser>({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true, unique: true },
  passwordHash: { type: String, required: true, select: false },
  authVersion: { type: Number, default: 0 },
  aiConsent: { type: new Schema({version:String,acceptedAt:Date,provider:String,endpoint:String}, {_id:false}), default:undefined },
  emailVerifiedAt: Date,
  deletionRequestedAt: Date,
}, { timestamps: true });

export const User = mongoose.model<IUser>('User', userSchema);
