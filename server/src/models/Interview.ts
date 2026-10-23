import mongoose, { Schema } from 'mongoose';

export type InterviewType = 'Technical' | 'Behavioral' | 'HR';
export type InterviewLevel = 'Beginner' | 'Intermediate' | 'Advanced';
export type InterviewStatus = 'in_progress' | 'completed';
export type AnswerTurn = {
  question: string;
  answer: string;
  topic: string;
  answeredAt: Date;
};
export type InterviewFeedback = {
  source: 'ai' | 'practice';
  score: number | null;
  strengths: string[];
  improvements: string[];
  summary: string;
  nextSteps: string[];
};
export interface IInterview {
  userId: mongoose.Types.ObjectId;
  role: string;
  type: InterviewType;
  difficulty: InterviewLevel;
  topic: string;
  totalQuestions: number;
  status: InterviewStatus;
  currentQuestion: string;
  currentTopic: string;
  turns: AnswerTurn[];
  feedback?: InterviewFeedback;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

const turnSchema = new Schema<AnswerTurn>({
  question: { type: String, required: true },
  answer: { type: String, required: true },
  topic: { type: String, required: true },
  answeredAt: { type: Date, required: true, default: Date.now },
}, { _id: false });

const feedbackSchema = new Schema<InterviewFeedback>({
  source: { type: String, enum: ['ai', 'practice'], required: true },
  score: { type: Number, default: null },
  strengths: { type: [String], default: [] },
  improvements: { type: [String], default: [] },
  summary: { type: String, required: true },
  nextSteps: { type: [String], default: [] },
}, { _id: false });

const interviewSchema = new Schema<IInterview>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  role: { type: String, required: true },
  type: { type: String, enum: ['Technical', 'Behavioral', 'HR'], required: true },
  difficulty: { type: String, enum: ['Beginner', 'Intermediate', 'Advanced'], required: true },
  topic: { type: String, required: true },
  totalQuestions: { type: Number, min: 2, max: 5, required: true },
  status: { type: String, enum: ['in_progress', 'completed'], default: 'in_progress' },
  currentQuestion: { type: String, required: true },
  currentTopic: { type: String, required: true },
  turns: { type: [turnSchema], default: [] },
  feedback: { type: feedbackSchema },
  completedAt: { type: Date },
}, { timestamps: true });
interviewSchema.index({ userId: 1, createdAt: -1 });

export const Interview = mongoose.model<IInterview>('Interview', interviewSchema);
