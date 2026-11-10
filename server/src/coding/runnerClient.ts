import type { CodeLanguage } from './types.js';
import type { RunnerResponse } from './grade.js';
import { identityToken } from '../services/googleIdentity.js';

// The runner is a separate service. On Cloud Run it only accepts calls signed with the app service account's
// identity token (RUNNER_AUTH=google); locally it listens on loopback (RUNNER_AUTH=none, or a shared
// RUNNER_TOKEN for a runner on another machine). RUNNER_AUTH=bearer with RUNNER_BEARER_TOKEN lets an operator
// check the deployed runner with their own identity token (gcloud auth print-identity-token).
export class RunnerUnavailableError extends Error {}
export const runnerUrl = () => process.env.RUNNER_URL?.replace(/\/+$/, '') || '';
export const runnerConfigured = () => Boolean(runnerUrl());

async function authHeaders(): Promise<Record<string, string>> {
  const auth = process.env.RUNNER_AUTH || 'none';
  if (auth === 'token') return { 'x-runner-token': process.env.RUNNER_TOKEN ?? '' };
  if (auth === 'bearer') return { authorization: `Bearer ${process.env.RUNNER_BEARER_TOKEN ?? ''}` };
  if (auth !== 'google') return {};
  try { return { authorization: `Bearer ${await identityToken(runnerUrl())}` }; }
  catch { throw new RunnerUnavailableError('Could not get an identity token for the runner.'); }
}

export async function runOnRunner(input: { language: CodeLanguage; source: string; stdin: string; timeLimitMs: number }): Promise<RunnerResponse> {
  if (!runnerConfigured()) throw new RunnerUnavailableError('The code runner is not configured.');
  let response: Response;
  try {
    response = await fetch(`${runnerUrl()}/run`, { method: 'POST', headers: { 'content-type': 'application/json', ...await authHeaders() },
      body: JSON.stringify(input), signal: AbortSignal.timeout(90_000) });
  } catch (err) {
    if (err instanceof RunnerUnavailableError) throw err;
    throw new RunnerUnavailableError('The code runner could not be reached.');
  }
  if (response.status === 429 || response.status === 503) throw new RunnerUnavailableError('The code runner is busy or starting. Please try again.');
  if (!response.ok && response.status !== 400) throw new RunnerUnavailableError('The code runner failed.');
  return await response.json() as RunnerResponse;
}

export async function runnerHealth(): Promise<{ ok: boolean; languages?: Record<string, string | null>; mode?: string } | null> {
  if (!runnerConfigured()) return null;
  try {
    const response = await fetch(`${runnerUrl()}/health`, { headers: await authHeaders(), signal: AbortSignal.timeout(5000) });
    return await response.json() as { ok: boolean; languages?: Record<string, string | null>; mode?: string };
  } catch { return { ok: false }; }
}
