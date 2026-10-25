export interface User { id: string; name: string; email: string; emailVerified?: boolean; preferences?: { deliveryMetrics: boolean } }
export type DocumentKind = 'resume' | 'job_description';
export interface QuestionGrounding { documentIds: string[]; source?: { documentId: string; kind: DocumentKind; quote: string; start: number; end: number } }
export interface CandidateDocument { id: string; kind: DocumentKind; title: string; chars: number; createdAt: string; deleting?: boolean; text?: string }
export interface Turn { question: string; answer: string; topic: string; answeredAt: string; elapsedSeconds?: number; pausedSeconds?: number; overTime?: boolean; grounding?: QuestionGrounding }
export interface Feedback {
  source: 'ai' | 'practice'; score: number | null; summary: string;
  strengths: string[]; improvements: string[]; nextSteps: string[];
  rubric?: { version: string; type: string; scale: string; anchors: string[]; criteria: { id: string; label: string; guidance: string }[] };
  answers?: { questionIndex: number; criteria: CriterionRating[]; review?: AnswerReview }[];
  generation?: { provider: string; model: string; promptVersion: string; inputHash: string; inputTokens: number | null; outputTokens: number | null; latencyMs: number };
}
export type Verdict = 'correct' | 'partly_correct' | 'incorrect' | 'not_answered';
export interface AnswerReview { verdict: Verdict; reason: string; keyPoints: string[]; tip: string }
export interface CriterionRating {
  criterionId: string; label: string; score: number | null; status: 'rated' | 'insufficient_evidence';
  rationale: string; improvement: string | null; evidence: { quote: string; start: number; end: number } | null;
  revisedBy?: string;
}
export interface ScoreChallenge {
  id: string; submissionId: string; questionIndex: number; criterionId: string; reason: string;
  state: 'queued' | 'processing' | 'resolved' | 'failed'; attempts: number; error?: string;
  original: CriterionRating; outcome?: { decision: 'upheld' | 'revised'; rating: CriterionRating };
  createdAt: string; resolvedAt?: string;
}
export type RewritePart = { kind: 'answer'; text: string; quote: string; start: number; end: number } | { kind: 'addition'; text: string };
export interface AnswerRewrite { questionIndex: number; parts: RewritePart[]; summary: string; dropped: number; createdAt: string }
export type FillerCount = { term: string; count: number };
export interface Delivery { seconds: number; words: number; wordsPerMinute: number | null; fillers: FillerCount[] }
export interface DeliveryClip { questionIndex: number; seconds: number; words: number; fillers: FillerCount[]; createdAt: string }
export type StarPart = { part: 'situation' | 'task' | 'action' | 'result'; status: 'found'; quote: string; start: number; end: number }
  | { part: 'situation' | 'task' | 'action' | 'result'; status: 'missing'; tip?: string };
export interface StarCheck { questionIndex: number; parts: StarPart[]; createdAt: string }
export interface Interview {
  _id: string; userId: string; role: string; type: 'Technical' | 'Behavioral' | 'HR';
  difficulty: 'Beginner' | 'Intermediate' | 'Advanced'; topic: string;
  totalQuestions: number; status: 'in_progress' | 'completed';
  currentQuestion: string; currentTopic: string; currentQuestionGrounding?: QuestionGrounding; documentIds?: string[];
  turns: Turn[]; createdAt: string; completedAt?: string; feedback?: Feedback;
  challenges?: ScoreChallenge[];
  rewrites?: AnswerRewrite[];
  deliveryClips?: DeliveryClip[];
  starChecks?: StarCheck[];
  timeLimitSeconds?: number; questionStartedAt?: string; pausedAt?: string; pausedMs?: number;
  language?: InterviewLanguage;
  answered?: number;
  processingState?: 'ready' | 'queued' | 'processing' | 'failed';
  processingError?: string;
  jobNextAttemptAt?: string;
}
export type InterviewLanguage = 'en' | 'hi' | 'hinglish';
export const LANGUAGE_LABELS: Record<InterviewLanguage, string> = { en: 'English', hi: 'हिन्दी (Hindi)', hinglish: 'Hinglish' };
// Browser speech language for reading questions aloud; Hinglish is Roman script, so an Indian English voice reads it best.
export const SPEECH_LANG: Record<InterviewLanguage, string | undefined> = { en: undefined, hi: 'hi-IN', hinglish: 'en-IN' };
export interface Overview { total: number; completed: number; averageScore: number | null; recent: Interview[] }
export type Mode = 'ai' | 'practice';
export class ApiError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

// timeoutMs is longer only where the server waits on a model, such as generating an interview's first question.
export async function api<T>(path: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    response = await fetch('/api' + path, {
      ...options, signal: controller.signal, credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
  } catch {
    throw new ApiError(controller.signal.aborted ? 'The request timed out. Please try again.' : 'Cannot reach InterviewIQ. Check your connection and try again.', 0);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
  let data: { error?: string } & T;
  try { data = await response.json(); } catch { throw new Error('Server returned an invalid response.'); }
  if (!response.ok) throw new ApiError(data?.error || `Request failed (${response.status}).`, response.status);
  return data;
}
