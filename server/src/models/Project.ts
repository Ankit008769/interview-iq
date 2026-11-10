import mongoose, { Schema } from 'mongoose';
import type { GenerationMetadata } from '../services/modelProvider.js';
import type { CodeSymbol, Dependency } from '../projects/codeIndex.js';
import type { ProjectFile, Skipped } from '../projects/ingest.js';
import type { SecretFinding } from '../projects/secrets.js';

// An uploaded project for project-defense interviews (roadmap C4). Only redacted source text is stored: secret
// values were replaced before saving and secret files were never kept. Uploaded code is never executed.
// Deleting a project removes the interview questions generated from it, as for resumes and job descriptions.
export const MAX_PROJECTS_PER_USER = 3;
export type ClaimEvidence = { path: string; line: number; kind: 'dependency' | 'symbol' | 'file' | 'text'; text: string };
export type ResumeClaim = { quote: string; start: number; end: number; keywords: string[]; status: 'supported' | 'partial' | 'not_found'; evidence: ClaimEvidence[] };
export type ClaimCheck = { documentId: mongoose.Types.ObjectId; documentTitle: string; claims: ResumeClaim[]; dropped: number; generation?: GenerationMetadata; createdAt: Date };
export interface IProject {
  userId: mongoose.Types.ObjectId;
  name: string;
  files: ProjectFile[];
  symbols: CodeSymbol[];
  dependencies: Dependency[];
  secrets: SecretFinding[];
  secretFiles: string[];
  skipped: Skipped;
  claimChecks: ClaimCheck[];
  deletingAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const generationSchema = new Schema<GenerationMetadata>({
  provider: String, model: String, promptVersion: String, inputHash: String,
  inputTokens: { type: Number, default: null }, outputTokens: { type: Number, default: null }, latencyMs: Number,
}, { _id: false });
const projectSchema = new Schema<IProject>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, maxlength: 80 },
  files: { type: [new Schema({ path: { type: String, required: true }, language: String, size: Number, lines: Number, text: { type: String, required: true } }, { _id: false })], default: [] },
  symbols: { type: [new Schema({ name: String, kind: { type: String, enum: ['function', 'method', 'class', 'component', 'route'] }, path: String, line: Number, endLine: Number }, { _id: false })], default: [] },
  dependencies: { type: [new Schema({ name: String, version: String, source: String }, { _id: false })], default: [] },
  secrets: { type: [new Schema({ path: String, line: Number, kind: String }, { _id: false })], default: [] },
  secretFiles: { type: [String], default: [] },
  skipped: { type: new Schema({ ignoredFolder: Number, binaryOrOther: Number, tooLarge: Number, secretFile: Number, overLimit: Number }, { _id: false }), required: true },
  claimChecks: { type: [new Schema({ documentId: Schema.Types.ObjectId, documentTitle: String, dropped: Number, generation: generationSchema, createdAt: Date,
    claims: [new Schema({ quote: String, start: Number, end: Number, keywords: [String], status: { type: String, enum: ['supported', 'partial', 'not_found'] },
      evidence: [new Schema({ path: String, line: Number, kind: { type: String, enum: ['dependency', 'symbol', 'file', 'text'] }, text: String }, { _id: false })] }, { _id: false })] }, { _id: false })], default: [] },
  deletingAt: Date,
}, { timestamps: true });

export const Project = mongoose.model<IProject>('Project', projectSchema, 'projects');
