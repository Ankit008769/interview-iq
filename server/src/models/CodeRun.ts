import mongoose, { Schema } from 'mongoose';
import type { GenerationMetadata } from '../services/modelProvider.js';
import type { CriterionRating } from '../services/evidence.js';
import type { SubmissionLanguage, TestStatus, Verdict } from '../coding/types.js';

// One run or submission in the coding lab (roadmap C2). Test outcomes come from the sandboxed runner; the AI
// follow-up question and review are stored separately and never change them. Hidden tests store only their
// status, never inputs or outputs.
export type CodeTestOutcome = { index: number; visible: boolean; large: boolean; status: TestStatus; ms?: number; error?: string; actual?: unknown };
export type CodeReview = { criteria: CriterionRating[]; summary: string; generation?: GenerationMetadata; createdAt: Date };
export type CodeFollowUp = { question: string; generation?: GenerationMetadata; askedAt: Date; answer?: string; answeredAt?: Date; review?: CodeReview };
export interface ICodeRun {
  userId: mongoose.Types.ObjectId;
  problemId: string;
  language: SubmissionLanguage;
  mode: 'run' | 'submit';
  source: string;
  verdict: Verdict;
  passed: number;
  total: number;
  tests: CodeTestOutcome[];
  output: string;
  message?: string;
  runMs?: number;
  compileMs?: number;
  runnerVersion?: string;
  followUp?: CodeFollowUp;
  createdAt: Date;
  updatedAt: Date;
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
const codeRunSchema = new Schema<ICodeRun>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  problemId: { type: String, required: true },
  language: { type: String, enum: ['javascript', 'typescript', 'python', 'java', 'cpp', 'sql'], required: true },
  mode: { type: String, enum: ['run', 'submit'], required: true },
  source: { type: String, required: true, maxlength: 65_536 },
  verdict: { type: String, enum: ['accepted', 'wrong_answer', 'runtime_error', 'time_limit', 'memory_limit', 'output_limit', 'compile_error', 'runner_error'], required: true },
  passed: { type: Number, required: true }, total: { type: Number, required: true },
  tests: { type: [new Schema({ index: Number, visible: Boolean, large: Boolean, status: { type: String, enum: ['passed', 'wrong_answer', 'error', 'not_run'] },
    ms: Number, error: String, actual: Schema.Types.Mixed }, { _id: false })], default: [] },
  output: { type: String, default: '', maxlength: 8000 },
  message: { type: String, maxlength: 8000 },
  runMs: Number, compileMs: Number, runnerVersion: String,
  followUp: { type: new Schema({ question: { type: String, required: true }, generation: generationSchema, askedAt: { type: Date, required: true },
    answer: { type: String, maxlength: 3500 }, answeredAt: Date,
    review: { type: new Schema({ criteria: [criterionSchema], summary: String, generation: generationSchema, createdAt: Date }, { _id: false }) } }, { _id: false }) },
}, { timestamps: true });
codeRunSchema.index({ userId: 1, problemId: 1, createdAt: -1 });
codeRunSchema.index({ userId: 1, createdAt: -1 });

export const CodeRun = mongoose.model<ICodeRun>('CodeRun', codeRunSchema, 'code_runs');
