export interface User { id: string; name: string; email: string; emailVerified?: boolean; preferences?: { deliveryMetrics: boolean } }
export type DocumentKind = 'resume' | 'job_description';
export interface CodeReference { projectId: string; path: string; symbol: string; kind: string; startLine: number; endLine: number; excerpt: string; referenced: 'model' | 'added' }
export interface QuestionGrounding { documentIds: string[]; source?: { documentId: string; kind: DocumentKind; quote: string; start: number; end: number }; code?: CodeReference }
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
  style?: InterviewStyle;
  purpose?: 'interview' | 'drill';
  focusSkills?: string[];
  answered?: number;
  processingState?: 'ready' | 'queued' | 'processing' | 'failed';
  processingError?: string;
  jobNextAttemptAt?: string;
}
// Asks the server to start loading its AI models before they are needed; a model that scaled to zero takes about
// a minute to wake. Fire and forget, at most once every four minutes per tab.
let lastWarmUp = 0;
export function warmUpAI() {
  if (Date.now() - lastWarmUp < 4 * 60_000) return;
  lastWarmUp = Date.now();
  api('/interviews/warmup', { method: 'POST' }).catch(() => {});
}
export type InterviewLanguage = 'en' | 'hi' | 'hinglish';
export type InterviewStyle = 'general' | 'product' | 'services' | 'startup';
export const STYLE_LABELS: Record<InterviewStyle, string> = { general: 'General', product: 'Product company', services: 'IT services', startup: 'Startup' };
export type InterviewType = 'Technical' | 'Behavioral' | 'HR';
export type SkillLevel = 'Needs work' | 'Developing' | 'Proficient' | 'Strong';
export type SkillView = { id: string; label: string; kind: 'topic' | 'competency'; type: InterviewType; foundations: string[] } & ({ practised: false } | {
  practised: true; mean: number; sd: number; lower: number; upper: number; level: SkillLevel; lowConfidence: boolean;
  observations: number; lastObservedAt: string; due: string; isDue: boolean; history: { at: string; mean: number }[] });
export interface DrillConfig { mode: 'ai'; purpose: 'drill'; role: string; type: InterviewType; topic: string; difficulty: Interview['difficulty'];
  totalQuestions: number; timeLimitSeconds: number; focusSkills: string[] }
export interface Drill { skillId: string; skillLabel: string; kind: 'retest' | 'weakest' | 'foundation' | 'baseline' | 'chosen'; reason: string; config: DrillConfig }
export interface StudyPlan { interviewDate: string; daysLeft: number; focusTypes: InterviewType[]; dailyMinutes: 10 | 20 | 30 }
export interface LearningOverview {
  aiAvailable: boolean; readiness: number | null; readinessByType: Record<InterviewType, number | null>; plan: StudyPlan | null;
  drill: Drill | null; skills: SkillView[]; dueCount: number; upcoming: { skillId: string; label: string; due: string }[];
  streak: { days: number; practisedToday: boolean };
}
export interface SkillChange { skillId: string; label: string; from: number; to: number; change: number; sinceFirstPractice: boolean }
export interface ProgressReport { weeks: { start: string; end: string; drills: number; interviews: number; averageScore: number | null }[]; gains: SkillChange[]; declines: SkillChange[] }
// The learner's own time zone decides what counts as today for streaks and the interview countdown.
export const timeZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata'; } catch { return 'Asia/Kolkata'; } };
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
// Coding lab (C2). Test results come from the sandboxed runner; the AI follow-up and review are separate.
export type CodeLang = 'javascript' | 'typescript' | 'python' | 'java' | 'cpp' | 'sql';
export type CodeVerdict = 'accepted' | 'wrong_answer' | 'runtime_error' | 'time_limit' | 'memory_limit' | 'output_limit' | 'compile_error' | 'runner_error';
export interface CodingStatus { runner: { configured: boolean; ready: boolean; languages: Record<string, string | null> }; aiAvailable: boolean }
export interface CodingProblemSummary { id: string; title: string; kind: 'algorithm' | 'debugging' | 'sql'; difficulty: Interview['difficulty']; topics: string[]; languages: CodeLang[]; submissions: number; solved: boolean }
export interface CodingProblem {
  id: string; title: string; kind: CodingProblemSummary['kind']; difficulty: Interview['difficulty']; topics: string[];
  statement: string; constraints: string[]; languages: CodeLang[]; hiddenTests: number;
  examples: { args: unknown[]; expected: unknown; explanation?: string }[];
  signature?: { name: string; params: { name: string; type: string }[]; returns: string }; compare?: 'exact' | 'unordered' | 'unordered-nested';
  schema?: string; columns?: string[]; ordered?: boolean;
  starters: Partial<Record<CodeLang, string>>;
}
export interface CodeTest { index: number; visible: boolean; large: boolean; status: 'passed' | 'wrong_answer' | 'error' | 'not_run'; ms?: number; error?: string; actual?: unknown }
export interface CodeRunSummary { id: string; language: CodeLang; mode: 'run' | 'submit'; verdict: CodeVerdict; passed: number; total: number; createdAt: string; followUp?: { review?: { createdAt: string } } }
export interface CodeRun extends CodeRunSummary {
  problemId: string; problemTitle?: string; source: string; tests: CodeTest[]; output: string; message?: string; runMs?: number; compileMs?: number;
  followUp?: { question: string; askedAt: string; answer?: string; answeredAt?: string; review?: { criteria: CriterionRating[]; summary: string; createdAt: string } };
}
// Project defense (C4): uploaded code, stored only after secret redaction and never run.
export interface ProjectStats { files: number; lines: number; bytes: number; symbols: number; dependencies: number; languages: { language: string; files: number }[] }
export interface SecretFinding { path: string; line: number; kind: string }
export interface ProjectSummary { id: string; name: string; createdAt: string; deleting: boolean; stats: ProjectStats;
  skipped: { ignoredFolder: number; binaryOrOther: number; tooLarge: number; secretFile: number; overLimit: number }; secrets: SecretFinding[]; secretFiles: string[] }
export interface CodeSymbol { name: string; kind: 'function' | 'method' | 'class' | 'component' | 'route'; path: string; line: number; endLine: number }
export interface ClaimEvidence { path: string; line: number; kind: 'dependency' | 'symbol' | 'file' | 'text'; text: string }
export interface ClaimCheck { documentId: string; documentTitle: string; dropped: number; createdAt: string;
  claims: { quote: string; keywords: string[]; status: 'supported' | 'partial' | 'not_found'; evidence: ClaimEvidence[] }[] }
export interface ProjectDetail extends ProjectSummary { files: { path: string; language: string; lines: number; size: number }[]; symbols: CodeSymbol[];
  dependencies: { name: string; version?: string; source: string }[]; claimChecks: ClaimCheck[] }
// System design (C3). The diagram is read by the app; the AI asks follow-ups and reviews.
export type StorageUnit = 'KB' | 'MB' | 'GB' | 'TB' | 'PB';
export interface DesignPromptSummary { id: string; title: string; difficulty: Interview['difficulty']; summary: string; sessions: number; reviewed: boolean }
export interface DesignPromptDetail { id: string; title: string; difficulty: Interview['difficulty']; summary: string; functional: string[]; nonFunctional: string[]; scale: string;
  estimates: { id: 'writeQps' | 'peakReadQps' | 'storagePerYear'; label: string; unit: string }[]; storageUnits: StorageUnit[] }
export interface DesignEstimates { writeQps?: number | null; peakReadQps?: number | null; storagePerYear?: { value: number; unit: StorageUnit } | null }
export interface DesignSessionView {
  id: string; promptId: string; status: 'drafting' | 'submitted' | 'reviewed'; scene: unknown[]; estimates: DesignEstimates; explanation: string; createdAt: string; submittedAt?: string;
  graph?: { nodes: { id: string; label: string; type: string }[]; edges: { from: string; to: string; label?: string }[]; notes: string[]; danglingArrows: number; unlabeledShapes: number };
  analysis?: { present: string[]; missing: string[]; isolated: string[]; observations: string[] };
  estimateCheck?: { id: string; label: string; given: number | null; reference: number; unit: string; ratio: number | null; verdict: 'close' | 'order_of_magnitude' | 'off' | 'missing'; formula: string }[];
  followUps: { index: number; constraint: string; question: string; referenced: 'model' | 'added'; answer?: string; rating?: number }[];
  review?: { criteria: CriterionRating[]; summary: string; createdAt: string };
}
