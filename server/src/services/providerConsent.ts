import { createHash } from 'node:crypto';
import { providerConfig } from './providerConfig.js';
import { User } from '../models/User.js';
import { runnerConfigured } from '../coding/runnerClient.js';
export class ConsentRequiredError extends Error {
  constructor() { super('AI consent is required or has changed. Review AI processing in Account, then retry. Your saved answers are retained.'); this.name = 'ConsentRequiredError'; }
}
export function aiDisclosure() {
  const config = providerConfig();
  if (config.provider === 'practice') return null;
  const endpoint = config.provider === 'openai' ? 'https://api.openai.com' : new URL(config.baseURL!).origin;
  // An open model on Interview IQ's own server: nothing goes to an outside AI company.
  if (config.provider === 'local') return fingerprint({
    policy: '2026-10-25.local.v1', provider: 'Open model on the Interview IQ server', endpoint: 'Interview IQ server (not shared with an AI company)',
    interviewerModel: config.interviewerModel, judgeModel: config.judgeModel,
    description: 'Your role, topic, interview questions and saved answers are processed by open-weight AI models running on the Interview IQ server to generate questions and coaching feedback. They are not sent to an outside AI company. Avoid entering secrets or sensitive personal information.',
    documents: 'If you choose a resume or job description for an AI interview, its full text is processed the same way, on the Interview IQ server, to tailor your questions.',
    retention: 'The models keep nothing between requests. Interview IQ retains your saved interviews until deletion.',
    withdrawal: 'You can withdraw permission in Account. This stops future AI processing, including queued work. Practice mode uses curated questions with no AI processing.',
    ...(config.transcriptionModel ? { transcriptionModel: config.transcriptionModel,
      voice: 'If you answer by voice, your recording is transcribed on the Interview IQ server and then discarded; only the text you review and submit is saved.' } : {}),
    ...(runnerConfigured() ? { coding: 'In the coding lab, your code runs in a separate sandbox with no network access and no AI. If you ask for the interviewer follow-up, your code and your explanation are processed by the same open models on the Interview IQ server.' } : {}),
  }, config.baseURL);
  const value = {
    policy: '2026-10-25.v2', provider: config.provider === 'openai' ? 'OpenAI' : (process.env.LLM_PROVIDER_NAME || 'Configured AI gateway'), endpoint,
    interviewerModel: config.interviewerModel,
    judgeModel: config.judgeModel,
    description: 'Your role, topic, interview questions and full saved answers are sent to this provider to generate follow-up questions and coaching feedback. Avoid entering secrets or sensitive personal information.',
    documents: 'If you choose a resume or job description for an AI interview, its full text is also sent to this provider to tailor your questions. Remove phone numbers, addresses and anything else you do not want to share before saving it.',
    retention: 'Provider processing and retention follow its terms. India-only processing, offline operation and zero retention are not guaranteed. Interview IQ retains your saved interviews until deletion.',
    withdrawal: 'You can withdraw permission in Account. This stops future requests, including queued work; it cannot recall data already sent or cancel an in-flight request. Practice mode sends no content to an AI provider.',
    // Added only when voice is enabled, so enabling it asks everyone to review the change.
    ...(config.transcriptionModel ? { transcriptionModel: config.transcriptionModel,
      voice: 'If you answer by voice, your recording is sent to this provider for transcription. Interview IQ does not store the recording; only the text you review and submit is saved.' } : {}),
    ...(runnerConfigured() ? { coding: 'In the coding lab, your code runs in the Interview IQ sandbox with no network access and no AI. If you ask for the interviewer follow-up, your code and your explanation are sent to this provider.' } : {}),
  };
  return fingerprint(value, config.baseURL);
}
// Include the full gateway path in the fingerprint without publishing it in UI.
function fingerprint<T extends object>(value: T, gateway?: string) {
  const version = createHash('sha256').update(JSON.stringify({ ...value, gateway: gateway || '' })).digest('hex');
  return { ...value, version };
}
export async function requireAIConsent(userId: string) {
  const disclosure = aiDisclosure();
  if (!disclosure || !await User.exists({_id:userId, deletionRequestedAt:{$exists:false}, 'aiConsent.version':disclosure.version})) throw new ConsentRequiredError();
  return disclosure;
}
