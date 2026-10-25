import mongoose from 'mongoose';
import { z } from 'zod';
import { CandidateDocument, DOCUMENT_KINDS, type DocumentKind } from '../models/CandidateDocument.js';
import { Interview, type QuestionGrounding } from '../models/Interview.js';

export const REMOVED_QUESTION = 'This question was removed because you deleted the document it was based on.';
export const MAX_SOURCE_QUOTE = 300;
export type GroundingDocument = { id: mongoose.Types.ObjectId; kind: DocumentKind; text: string };
export const questionSourceSchema = z.object({ document: z.enum(DOCUMENT_KINDS), quote: z.string() }).nullable();

// Only the owner's documents that are not being deleted can shape new questions. Resume first, so the
// prompt is the same whatever order they were chosen in.
export async function groundingDocuments(userId: string | mongoose.Types.ObjectId, ids: (string | mongoose.Types.ObjectId)[]): Promise<GroundingDocument[]> {
  if (!ids.length) return [];
  const docs = await CandidateDocument.find({ _id: { $in: ids }, userId, deletingAt: { $exists: false } }).select('kind text');
  return docs.map(d => ({ id: d._id, kind: d.kind, text: d.text }))
    .sort((a, b) => DOCUMENT_KINDS.indexOf(a.kind) - DOCUMENT_KINDS.indexOf(b.kind));
}

// A source is kept only when its passage is found verbatim in the named document; otherwise the question
// is still shown, without a source line.
export function verifyQuestionSource(source: z.infer<typeof questionSourceSchema>, documents: GroundingDocument[]): QuestionGrounding['source'] {
  const doc = source && documents.find(d => d.kind === source.document);
  const quote = source?.quote.trim();
  if (!doc || !quote || quote.length > MAX_SOURCE_QUOTE) return undefined;
  const start = doc.text.indexOf(quote);
  return start < 0 ? undefined : { documentId: doc.id, kind: doc.kind, quote, start, end: start + quote.length };
}

// Order matters. Pulling the ID first makes in-flight workers' fenced writes miss, so they requeue without the
// document. Clearing the current question before saved turns means an answer that copies it in between is
// still caught by the turn pass, and answers submitted after see a changed question and are rejected.
export async function removeDerivedQuestions(userId: string | mongoose.Types.ObjectId, ids: mongoose.Types.ObjectId[], interviewId?: mongoose.Types.ObjectId) {
  const scope = { userId, ...(interviewId ? { _id: interviewId } : {}) };
  for (const id of ids) {
    await Interview.updateMany({ ...scope, documentIds: id }, { $pull: { documentIds: id } });
    await Interview.updateMany({ ...scope, 'currentQuestionGrounding.documentIds': id },
      { $set: { currentQuestion: REMOVED_QUESTION }, $unset: { currentQuestionGrounding: 1 } });
    await Interview.updateMany({ ...scope, 'turns.grounding.documentIds': id },
      { $set: { 'turns.$[t].question': REMOVED_QUESTION }, $unset: { 'turns.$[t].grounding': 1 } },
      { arrayFilters: [{ 't.grounding.documentIds': id }] });
  }
}

// Marking first stops new use; the cleanup is idempotent, so a repeated DELETE finishes an interrupted one.
export async function deleteCandidateDocument(userId: string, id: string): Promise<boolean> {
  const doc = await CandidateDocument.findOneAndUpdate({ _id: id, userId }, { $min: { deletingAt: new Date() } }, { new: true }).select('_id');
  if (!doc) return false;
  await removeDerivedQuestions(userId, [doc._id]);
  await CandidateDocument.deleteOne({ _id: doc._id, userId });
  return true;
}
