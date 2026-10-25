import mongoose, { Schema } from 'mongoose';

export type DocumentKind = 'resume' | 'job_description';
export const DOCUMENT_KINDS = ['resume', 'job_description'] as const;
export const MAX_DOCUMENT_CHARS = 12_000;
export const MAX_DOCUMENTS_PER_USER = 10;

// A resume or job description the candidate pasted to tailor AI questions. deletingAt marks a deletion in
// progress: from then on it is never used for new questions, and a repeated DELETE finishes the cleanup.
export interface ICandidateDocument {
  userId: mongoose.Types.ObjectId;
  kind: DocumentKind;
  title: string;
  text: string;
  chars: number;
  deletingAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const documentSchema = new Schema<ICandidateDocument>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  kind: { type: String, enum: DOCUMENT_KINDS, required: true },
  title: { type: String, required: true, maxlength: 80 },
  text: { type: String, required: true, maxlength: MAX_DOCUMENT_CHARS },
  chars: { type: Number, required: true },
  deletingAt: { type: Date },
}, { timestamps: true });
documentSchema.index({ userId: 1, createdAt: -1 });

export const CandidateDocument = mongoose.model<ICandidateDocument>('CandidateDocument', documentSchema, 'documents');
