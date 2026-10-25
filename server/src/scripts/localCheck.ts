import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateInterview, generateQuestion } from '../services/ai.js';
import { providerConfig } from '../services/providerConfig.js';
import { parseItems } from '../calibration/dataset.js';

// Operator check that the configured models answer in the expected format, with timings:
// one generated question and one scored calibration answer. Uses no database and no user data.
//   npm run local-check [-- --item <calibration item id>]
async function main() {
  const config = providerConfig();
  if (config.provider === 'practice') throw new Error('Set AI_PROVIDER (for example local) first.');
  console.log(`Provider ${config.provider} · questions ${config.interviewerModel} · scoring ${config.judgeModel} · timeout ${config.timeoutMs / 1000}s`);
  let started = Date.now();
  const question = await generateQuestion({ mode: 'ai', role: 'Software Development Engineer', type: 'Technical', difficulty: 'Intermediate', topic: 'DSA', turnIndex: 0, history: [] });
  console.log(`Question in ${((Date.now() - started) / 1000).toFixed(1)}s (${question.generation?.inputTokens ?? '?'} in / ${question.generation?.outputTokens ?? '?'} out): ${question.question}`);
  const items = parseItems(readFileSync(fileURLToPath(new URL('../../../calibration/items.synthetic.v1.jsonl', import.meta.url)), 'utf8'));
  const wanted = process.argv.indexOf('--item');
  const item = wanted > 0 ? items.find(i => i.id === process.argv[wanted + 1]) : items.find(i => i.type === 'Technical' && i.intendedQuality === 'strong');
  if (!item) throw new Error('Calibration item not found.');
  started = Date.now();
  const feedback = await evaluateInterview({ mode: 'ai', role: item.role, type: item.type, difficulty: item.difficulty, topic: item.topic,
    history: [{ question: item.question, answer: item.answer, topic: item.topic, answeredAt: new Date() }] });
  console.log(`Scored item ${item.id} (${item.intendedQuality}) in ${((Date.now() - started) / 1000).toFixed(1)}s (${feedback.generation?.inputTokens ?? '?'} in / ${feedback.generation?.outputTokens ?? '?'} out): overall ${feedback.score ?? 'not scored'}`);
  for (const c of feedback.answers?.[0]?.criteria ?? []) console.log(`  ${c.label}: ${c.score ?? 'insufficient evidence'}${c.evidence ? ` · “${c.evidence.quote.slice(0, 80)}”` : ''}`);
}
main().catch(err => { console.error(err instanceof Error ? err.message : 'Local check failed.'); process.exitCode = 1; });
