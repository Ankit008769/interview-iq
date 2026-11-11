import mongoose, { Schema } from 'mongoose';
import type { GenerationMetadata } from '../services/modelProvider.js';
import type { CriterionRating } from '../services/evidence.js';
import type { DesignGraph } from '../design/graph.js';
import type { EstimateInput, EstimateResult } from '../design/estimates.js';

// One attempt at a system-design prompt (roadmap C3): the drawing, capacity estimates and written reasoning;
// once submitted, the app's reading of the drawing and of the estimates, then up to two "changing
// constraints" questions from the AI interviewer, each rated by the candidate for relevance, and a review.
export const DESIGN_FOLLOW_UPS = 2;
export type DesignFollowUp = { index: number; constraint: string; question: string; referenced: 'model' | 'added'; generation?: GenerationMetadata; askedAt: Date;
  answer?: string; answeredAt?: Date; rating?: number };
export interface IDesignSession {
  userId: mongoose.Types.ObjectId;
  promptId: string;
  status: 'drafting' | 'submitted' | 'reviewed';
  scene: unknown[];
  estimates: EstimateInput;
  explanation: string;
  submittedAt?: Date;
  graph?: DesignGraph;
  analysis?: { present: string[]; missing: string[]; isolated: string[]; observations: string[] };
  estimateCheck?: EstimateResult[];
  followUps: DesignFollowUp[];
  review?: { criteria: CriterionRating[]; summary: string; generation?: GenerationMetadata; createdAt: Date };
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
const sessionSchema = new Schema<IDesignSession>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  promptId: { type: String, required: true },
  status: { type: String, enum: ['drafting', 'submitted', 'reviewed'], default: 'drafting' },
  scene: { type: [Schema.Types.Mixed], default: [] },
  estimates: { type: new Schema({ writeQps: Number, peakReadQps: Number,
    storagePerYear: { type: new Schema({ value: Number, unit: { type: String, enum: ['KB', 'MB', 'GB', 'TB', 'PB'] } }, { _id: false }) } }, { _id: false }), default: {} },
  explanation: { type: String, default: '', maxlength: 4000 },
  submittedAt: Date,
  graph: { type: Schema.Types.Mixed },
  analysis: { type: Schema.Types.Mixed },
  estimateCheck: { type: [Schema.Types.Mixed], default: undefined },
  followUps: { type: [new Schema({ index: Number, constraint: String, question: String, referenced: { type: String, enum: ['model', 'added'] }, generation: generationSchema,
    askedAt: Date, answer: { type: String, maxlength: 2000 }, answeredAt: Date, rating: { type: Number, min: 1, max: 5 } }, { _id: false })], default: [] },
  review: { type: new Schema({ criteria: [criterionSchema], summary: String, generation: generationSchema, createdAt: Date }, { _id: false }) },
}, { timestamps: true });
sessionSchema.index({ userId: 1, promptId: 1, createdAt: -1 });

export const DesignSession = mongoose.model<IDesignSession>('DesignSession', sessionSchema, 'design_sessions');

// Only drawing elements and the fields Excalidraw needs to redraw them are kept: no images, embeds or files.
const ELEMENT_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'arrow', 'line', 'text', 'freedraw']);
const KEYS = ['id', 'type', 'x', 'y', 'width', 'height', 'angle', 'strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity',
  'groupIds', 'frameId', 'roundness', 'seed', 'version', 'versionNonce', 'isDeleted', 'boundElements', 'updated', 'link', 'locked', 'points', 'lastCommittedPoint',
  'startBinding', 'endBinding', 'startArrowhead', 'endArrowhead', 'elbowed', 'text', 'originalText', 'fontSize', 'fontFamily', 'textAlign', 'verticalAlign',
  'containerId', 'lineHeight', 'autoResize', 'baseline', 'pressures', 'simulatePressure'];
export const MAX_ELEMENTS = 1500;
export function sanitizeScene(input: unknown): unknown[] {
  if (!Array.isArray(input)) return [];
  return input.filter(e => e && typeof e === 'object' && ELEMENT_TYPES.has((e as { type?: string }).type ?? '') && !(e as { isDeleted?: boolean }).isDeleted)
    .slice(0, MAX_ELEMENTS).map(e => {
      const element = e as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of KEYS) if (key in element) out[key] = element[key];
      for (const key of ['text', 'originalText']) if (typeof out[key] === 'string') out[key] = (out[key] as string).slice(0, 500);
      if (typeof out.link === 'string') delete out.link;
      for (const key of ['points', 'pressures']) if (Array.isArray(out[key])) out[key] = (out[key] as unknown[]).slice(0, 500);
      return out;
    });
}
