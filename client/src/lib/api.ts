export interface User { id: string; name: string; email: string }
export interface Turn { question: string; answer: string; topic: string; answeredAt: string }
export interface Feedback {
  source: 'ai' | 'practice'; score: number | null; summary: string;
  strengths: string[]; improvements: string[]; nextSteps: string[];
}
export interface Interview {
  _id: string; userId: string; role: string; type: 'Technical' | 'Behavioral' | 'HR';
  difficulty: 'Beginner' | 'Intermediate' | 'Advanced'; topic: string;
  totalQuestions: number; status: 'in_progress' | 'completed';
  currentQuestion: string; currentTopic: string;
  turns: Turn[]; createdAt: string; completedAt?: string; feedback?: Feedback;
  answered?: number;
  processingState?: 'ready' | 'queued' | 'processing' | 'failed';
  processingError?: string;
  jobNextAttemptAt?: string;
}
export interface Overview { total: number; completed: number; averageScore: number | null; recent: Interview[] }
export type Mode = 'ai' | 'practice';
export class ApiError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
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
