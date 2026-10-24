import mongoose, { Schema } from 'mongoose';
import type { GenerationMetadata } from '../services/modelProvider.js';
import type { AnswerEvaluation } from '../services/evidence.js';
import type { rubricFor } from '../services/rubrics.js';

export type InterviewType = 'Technical' | 'Behavioral' | 'HR';
export type InterviewLevel = 'Beginner' | 'Intermediate' | 'Advanced';
export type InterviewStatus = 'in_progress' | 'completed';
export type AnswerTurn = {
  submissionId?: string;
  questionIndex?: number;
  questionId?: string;
  question: string;
  answer: string;
  topic: string;
  answeredAt: Date;
  questionGeneration?: GenerationMetadata;
};
export type InterviewFeedback = {
  source: 'ai' | 'practice';
  score: number | null;
  strengths: string[];
  improvements: string[];
  summary: string;
  nextSteps: string[];
  rubric?: ReturnType<typeof rubricFor>;
  answers?: AnswerEvaluation[];
  generation?: GenerationMetadata;
};
export interface IInterview {
  mode?: 'ai' | 'practice';
  processingState: 'ready' | 'queued' | 'processing' | 'failed';
  jobAttempts: number;
  jobLeaseToken?: string;
  jobLeaseUntil?: Date;
  jobNextAttemptAt?: Date;
  processingError?: string;
  userId: mongoose.Types.ObjectId;
  role: string;
  type: InterviewType;
  difficulty: InterviewLevel;
  topic: string;
  totalQuestions: number;
  status: InterviewStatus;
  currentQuestion: string;
  currentTopic: string;
  currentQuestionId?: string;
  currentQuestionGeneration?: GenerationMetadata;
  turns: AnswerTurn[];
  feedback?: InterviewFeedback;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

const generationSchema = new Schema<GenerationMetadata>({
  provider: String, model: String, promptVersion: String, inputHash: String,
  inputTokens: { type: Number, default: null }, outputTokens: { type: Number, default: null }, latencyMs: Number,
}, { _id: false });
const criterionSchema = new Schema({
  criterionId: { type: String, required: true }, label: { type: String, required: true },
  score: { type: Number, min: 0, max: 5, default: null },
  status: { type: String, enum: ['rated', 'insufficient_evidence'], required: true },
  rationale: String, improvement: { type: String, default: null },
  evidence: { type: new Schema({ quote: String, start: Number, end: Number }, { _id: false }), default: null },
}, { _id: false });
const rubricSchema = new Schema({ version: String, type: String, scale: String, anchors: [String],
  criteria: [new Schema({ id: String, label: String, guidance: String }, { _id: false })],
}, { _id: false });
const turnSchema = new Schema<AnswerTurn>({
  submissionId: { type: String },
  questionIndex: { type: Number, min: 0 },
  questionId: { type: String },
  question: { type: String, required: true },
  answer: { type: String, required: true },
  topic: { type: String, required: true },
  answeredAt: { type: Date, required: true, default: Date.now },
  questionGeneration: { type: generationSchema },
}, { _id: false });

const feedbackSchema = new Schema<InterviewFeedback>({
  source: { type: String, enum: ['ai', 'practice'], required: true },
  score: { type: Number, default: null },
  strengths: { type: [String], default: [] },
  improvements: { type: [String], default: [] },
  summary: { type: String, required: true },
  nextSteps: { type: [String], default: [] },
  rubric: { type: rubricSchema },
  answers: { type: [new Schema({ questionIndex: Number, criteria: [criterionSchema] }, { _id: false })], default: undefined },
  generation: { type: generationSchema },
}, { _id: false });

const interviewSchema = new Schema<IInterview>({
  mode: { type: String, enum: ['ai', 'practice'] },
  processingState: { type: String, enum: ['ready', 'queued', 'processing', 'failed'], default: 'ready' },
  jobAttempts: { type: Number, default: 0 },
  jobLeaseToken: { type: String, select: false },
  jobLeaseUntil: Date,
  jobNextAttemptAt: Date,
  processingError: String,
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  role: { type: String, required: true },
  type: { type: String, enum: ['Technical', 'Behavioral', 'HR'], required: true },
  difficulty: { type: String, enum: ['Beginner', 'Intermediate', 'Advanced'], required: true },
  topic: { type: String, required: true },
  totalQuestions: { type: Number, min: 2, max: 5, required: true },
  status: { type: String, enum: ['in_progress', 'completed'], default: 'in_progress' },
  currentQuestion: { type: String, required: true },
  currentTopic: { type: String, required: true },
  currentQuestionId: { type: String },
  currentQuestionGeneration: { type: generationSchema },
  turns: { type: [turnSchema], default: [] },
  feedback: { type: feedbackSchema },
  completedAt: { type: Date },
}, { timestamps: true });
interviewSchema.index({ userId: 1, createdAt: -1, _id: -1 });
interviewSchema.index({ processingState: 1, jobNextAttemptAt: 1, jobLeaseUntil: 1 });

export const Interview = mongoose.model<IInterview>('Interview', interviewSchema);
