import { createHash } from 'node:crypto';
import { providerConfig } from './providerConfig.js';
import { User } from '../models/User.js';
export class ConsentRequiredError extends Error {
  constructor() { super('AI consent is required or has changed. Review AI processing in Account, then retry. Your saved answers are retained.'); this.name = 'ConsentRequiredError'; }
}
export function aiDisclosure() {
  const config = providerConfig();
  if (config.provider === 'practice') return null;
  const endpoint = config.provider === 'openai' ? 'https://api.openai.com' : new URL(config.baseURL!).origin;
  const value = {
    policy: '2026-10-24.v1', provider: config.provider === 'openai' ? 'OpenAI' : (process.env.LLM_PROVIDER_NAME || 'Configured AI gateway'), endpoint,
    interviewerModel: process.env.INTERVIEWER_MODEL || process.env.AI_MODEL || 'gpt-4o-mini',
    judgeModel: process.env.JUDGE_MODEL || process.env.AI_MODEL || 'gpt-4o-mini',
    description: 'Your role, topic, interview questions and full saved answers are sent to this provider to generate follow-up questions and coaching feedback. Avoid entering secrets or sensitive personal information.',
    retention: 'Provider processing and retention follow its terms. India-only processing, offline operation and zero retention are not guaranteed. Interview IQ retains your saved interviews until deletion.',
    withdrawal: 'You can withdraw permission in Account. This stops future requests, including queued work; it cannot recall data already sent or cancel an in-flight request. Practice mode sends no content to an AI provider.',
    // Added only when voice is enabled, so enabling it asks everyone to review the change.
    ...(config.transcriptionModel ? { transcriptionModel: config.transcriptionModel,
      voice: 'If you answer by voice, your recording is sent to this provider for transcription. Interview IQ does not store the recording; only the text you review and submit is saved.' } : {}),
  };
  // Include the full gateway path in the fingerprint without publishing it in UI.
  const version = createHash('sha256').update(JSON.stringify({ ...value, gateway:config.baseURL || '' })).digest('hex');
  return {...value, version};
}
export async function requireAIConsent(userId: string) {
  const disclosure = aiDisclosure();
  if (!disclosure || !await User.exists({_id:userId, deletionRequestedAt:{$exists:false}, 'aiConsent.version':disclosure.version})) throw new ConsentRequiredError();
  return disclosure;
}
