import mongoose, { Schema } from 'mongoose';

// Adaptive practice state (roadmap C5). Each user has one SkillState per skill they have evidence for, and at most
// one StudyPlan. Both are deleted with the account and included in the data export. Skill states are a cache:
// they are rebuilt by replaying the user's AI-scored interviews, so they can always be recomputed from interviews.
export type SkillHistoryPoint = { at: Date; mean: number; sd: number; interviewId: mongoose.Types.ObjectId };
export interface ISkillState {
  userId: mongoose.Types.ObjectId;
  skillId: string;
  mean: number;
  variance: number;
  observations: number;
  lastObservedAt?: Date;
  card: { due: Date; stability: number; difficulty: number; elapsed_days: number; scheduled_days: number; learning_steps: number;
    reps: number; lapses: number; state: number; last_review?: Date };
  history: SkillHistoryPoint[];
  // The newest interview update the replay saw. A slower rebuild from older data never overwrites a newer one.
  basisAt: Date;
}
const skillStateSchema = new Schema<ISkillState>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  skillId: { type: String, required: true },
  mean: { type: Number, required: true, min: 0, max: 5 },
  variance: { type: Number, required: true, min: 0 },
  observations: { type: Number, default: 0 },
  lastObservedAt: Date,
  card: { type: new Schema({ due: Date, stability: Number, difficulty: Number, elapsed_days: Number, scheduled_days: Number,
    learning_steps: Number, reps: Number, lapses: Number, state: Number, last_review: Date }, { _id: false }), required: true },
  history: { type: [new Schema({ at: Date, mean: Number, sd: Number, interviewId: Schema.Types.ObjectId }, { _id: false })], default: [] },
  basisAt: { type: Date, required: true },
}, { timestamps: true });
skillStateSchema.index({ userId: 1, skillId: 1 }, { unique: true });
export const SkillState = mongoose.model<ISkillState>('SkillState', skillStateSchema, 'skill_states');

export const PLAN_MINUTES = [10, 20, 30] as const;
export interface IStudyPlan {
  userId: mongoose.Types.ObjectId;
  interviewDate: Date;
  focusTypes: ('Technical' | 'Behavioral' | 'HR')[];
  dailyMinutes: typeof PLAN_MINUTES[number];
  createdAt: Date; updatedAt: Date;
}
const studyPlanSchema = new Schema<IStudyPlan>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  interviewDate: { type: Date, required: true },
  focusTypes: { type: [String], enum: ['Technical', 'Behavioral', 'HR'], required: true },
  dailyMinutes: { type: Number, enum: PLAN_MINUTES, required: true },
}, { timestamps: true });
export const StudyPlan = mongoose.model<IStudyPlan>('StudyPlan', studyPlanSchema, 'study_plans');
