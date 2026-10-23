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
}
export interface Overview { total: number; completed: number; averageScore: number | null; recent: Interview[] }
export type Mode = 'ai' | 'practice';

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api' + path, {
      ...options, credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
  } catch {
    throw new Error('Cannot reach InterviewIQ API. Is the backend running on port 5000?');
  }
  let data: { error?: string } & T;
  try { data = await response.json(); } catch { throw new Error('Server returned an invalid response.'); }
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status}).`);
  return data;
}
