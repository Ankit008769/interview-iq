import mongoose, { Schema } from 'mongoose';
import type { GenerationMetadata } from '../services/modelProvider.js';
import type { AnswerEvaluation, CriterionRating, RewritePart, StarPart } from '../services/evidence.js';
import type { rubricFor } from '../services/rubrics.js';

export type InterviewType = 'Technical' | 'Behavioral' | 'HR';
export type InterviewLevel = 'Beginner' | 'Intermediate' | 'Advanced';
export type InterviewStatus = 'in_progress' | 'completed';
export const INTERVIEW_LANGUAGES = ['en', 'hi', 'hinglish'] as const;
export type InterviewLanguage = typeof INTERVIEW_LANGUAGES[number];
// Interview styles shape AI questions like a kind of employer, without imitating any real company.
export const INTERVIEW_STYLES = ['general', 'product', 'services', 'startup'] as const;
export type InterviewStyle = typeof INTERVIEW_STYLES[number];
// Which of the candidate's documents a question was generated from, and the passage it is based on when
// that passage was found verbatim. Deleting a document removes every question that lists it.
// In a project-defense interview, the code a question is about: the app chooses the function or class and keeps
// the redacted excerpt shown with the question. referenced says whether the model named it or the app added it.
export type CodeReference = { projectId: mongoose.Types.ObjectId; path: string; symbol: string; kind: string; startLine: number; endLine: number;
  excerpt: string; referenced: 'model' | 'added' };
export type QuestionGrounding = {
  documentIds: mongoose.Types.ObjectId[];
  source?: { documentId: mongoose.Types.ObjectId; kind: 'resume' | 'job_description'; quote: string; start: number; end: number };
  code?: CodeReference;
};
export type AnswerTurn = {
  submissionId?: string;
  questionIndex?: number;
  questionId?: string;
  question: string;
  answer: string;
  topic: string;
  answeredAt: Date;
  questionGeneration?: GenerationMetadata;
  grounding?: QuestionGrounding;
  elapsedSeconds?: number;
  pausedSeconds?: number;
  overTime?: boolean;
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
export type ScoreChallenge = {
  id: string;
  submissionId: string;
  questionIndex: number;
  criterionId: string;
  reason: string;
  state: 'queued' | 'processing' | 'resolved' | 'failed';
  attempts: number;
  leaseToken?: string;
  leaseUntil?: Date;
  nextAttemptAt?: Date;
  error?: string;
  original: CriterionRating;
  outcome?: { decision: 'upheld' | 'revised'; rating: CriterionRating; generation?: GenerationMetadata };
  createdAt: Date;
  resolvedAt?: Date;
};
export type AnswerRewrite = {
  questionIndex: number;
  parts: RewritePart[];
  summary: string;
  dropped: number;
  generation?: GenerationMetadata;
  createdAt: Date;
};
// Measured from one recording sent for transcription while a question was on screen. Counts only; no audio or text.
export type DeliveryClip = {
  questionIndex: number;
  seconds: number;
  words: number;
  fillers: { term: string; count: number }[];
  version: string;
  createdAt: Date;
};
export type StarCheck = {
  questionIndex: number;
  parts: StarPart[];
  generation?: GenerationMetadata;
  createdAt: Date;
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
  currentQuestionGrounding?: QuestionGrounding;
  documentIds: mongoose.Types.ObjectId[];
  projectId?: mongoose.Types.ObjectId;
  language: InterviewLanguage;
  style: InterviewStyle;
  purpose: 'interview' | 'drill';
  focusSkills: string[];
  timeLimitSeconds?: number;
  questionStartedAt?: Date;
  pausedAt?: Date;
  pausedMs: number;
  turns: AnswerTurn[];
  feedback?: InterviewFeedback;
  challenges: ScoreChallenge[];
  rewrites: AnswerRewrite[];
  deliveryClips: DeliveryClip[];
  starChecks: StarCheck[];
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
  revisedBy: { type: String },
}, { _id: false });
const challengeSchema = new Schema<ScoreChallenge>({
  id: { type: String, required: true }, submissionId: { type: String, required: true },
  questionIndex: { type: Number, min: 0, max: 4, required: true }, criterionId: { type: String, required: true },
  reason: { type: String, required: true },
  state: { type: String, enum: ['queued', 'processing', 'resolved', 'failed'], required: true },
  attempts: { type: Number, default: 0 }, leaseToken: String, leaseUntil: Date, nextAttemptAt: Date, error: String,
  original: { type: criterionSchema, required: true },
  outcome: { type: new Schema({ decision: { type: String, enum: ['upheld', 'revised'] }, rating: criterionSchema,
    generation: generationSchema }, { _id: false }) },
  createdAt: { type: Date, default: Date.now }, resolvedAt: Date,
}, { _id: false, id: false, toJSON: { transform: (_doc, ret: any) => { delete ret.leaseToken; return ret; } } });
const rewriteSchema = new Schema<AnswerRewrite>({
  questionIndex: { type: Number, min: 0, max: 4, required: true },
  parts: [new Schema({ kind: { type: String, enum: ['answer', 'addition'], required: true }, text: { type: String, required: true },
    quote: String, start: Number, end: Number }, { _id: false })],
  summary: { type: String, default: '' }, dropped: { type: Number, default: 0 },
  generation: generationSchema, createdAt: { type: Date, default: Date.now },
}, { _id: false });
const deliveryClipSchema = new Schema<DeliveryClip>({
  questionIndex: { type: Number, min: 0, max: 4, required: true },
  seconds: { type: Number, min: 0, required: true }, words: { type: Number, min: 0, required: true },
  fillers: [new Schema({ term: { type: String, required: true }, count: { type: Number, min: 1, required: true } }, { _id: false })],
  version: { type: String, required: true }, createdAt: { type: Date, default: Date.now },
}, { _id: false });
const starCheckSchema = new Schema<StarCheck>({
  questionIndex: { type: Number, min: 0, max: 4, required: true },
  parts: [new Schema({ part: { type: String, enum: ['situation', 'task', 'action', 'result'], required: true },
    status: { type: String, enum: ['found', 'missing'], required: true }, quote: String, start: Number, end: Number, tip: String }, { _id: false })],
  generation: generationSchema, createdAt: { type: Date, default: Date.now },
}, { _id: false });
const rubricSchema = new Schema({ version: String, type: String, scale: String, anchors: [String],
  criteria: [new Schema({ id: String, label: String, guidance: String }, { _id: false })],
}, { _id: false });
const groundingSchema = new Schema<QuestionGrounding>({
  documentIds: { type: [Schema.Types.ObjectId], default: [] },
  source: { type: new Schema({ documentId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, enum: ['resume', 'job_description'], required: true },
    quote: { type: String, required: true }, start: Number, end: Number }, { _id: false }) },
  code: { type: new Schema({ projectId: { type: Schema.Types.ObjectId, required: true }, path: { type: String, required: true }, symbol: { type: String, required: true },
    kind: String, startLine: Number, endLine: Number, excerpt: { type: String, maxlength: 12000 }, referenced: { type: String, enum: ['model', 'added'] } }, { _id: false }) },
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
  grounding: { type: groundingSchema },
  elapsedSeconds: { type: Number, min: 0 },
  pausedSeconds: { type: Number, min: 0 },
  overTime: { type: Boolean },
}, { _id: false });

const feedbackSchema = new Schema<InterviewFeedback>({
  source: { type: String, enum: ['ai', 'practice'], required: true },
  score: { type: Number, default: null },
  strengths: { type: [String], default: [] },
  improvements: { type: [String], default: [] },
  summary: { type: String, required: true },
  nextSteps: { type: [String], default: [] },
  rubric: { type: rubricSchema },
  answers: { type: [new Schema({ questionIndex: Number, criteria: [criterionSchema],
    review: { type: new Schema({ verdict: { type: String, enum: ['correct', 'partly_correct', 'incorrect', 'not_answered'] }, reason: String,
      keyPoints: [String], tip: String }, { _id: false }) } }, { _id: false })], default: undefined },
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
  currentQuestionGrounding: { type: groundingSchema },
  documentIds: { type: [Schema.Types.ObjectId], default: [] },
  projectId: { type: Schema.Types.ObjectId },
  language: { type: String, enum: INTERVIEW_LANGUAGES, default: 'en' },
  style: { type: String, enum: INTERVIEW_STYLES, default: 'general' },
  purpose: { type: String, enum: ['interview', 'drill'], default: 'interview' },
  focusSkills: { type: [String], default: [] },
  timeLimitSeconds: { type: Number, enum: [120, 180, 300] },
  questionStartedAt: { type: Date },
  pausedAt: { type: Date },
  pausedMs: { type: Number, default: 0, min: 0 },
  turns: { type: [turnSchema], default: [] },
  feedback: { type: feedbackSchema },
  challenges: { type: [challengeSchema], default: [] },
  rewrites: { type: [rewriteSchema], default: [] },
  deliveryClips: { type: [deliveryClipSchema], default: [] },
  starChecks: { type: [starCheckSchema], default: [] },
  completedAt: { type: Date },
}, { timestamps: true });
interviewSchema.index({ userId: 1, createdAt: -1, _id: -1 });
interviewSchema.index({ processingState: 1, jobNextAttemptAt: 1, jobLeaseUntil: 1 });
interviewSchema.index({ 'challenges.state': 1, 'challenges.nextAttemptAt': 1 });
interviewSchema.index({ userId: 1, status: 1, completedAt: 1 });

export const Interview = mongoose.model<IInterview>('Interview', interviewSchema);
