import { writeFileSync } from 'node:fs';
import { generateQuestion } from '../services/ai.js';
import { providerConfig } from '../services/providerConfig.js';
import { REGIONAL_LANGUAGES, type InterviewLanguage } from '../models/Interview.js';

// Operator check for regional-language interviews (E2) with the configured local model, without a database.
// For each language it asks for HR and behavioural questions and measures:
// - script conformity: the share of letters written in the language's own script (the rest is usually Latin
//   technical terms or English that crept in);
// - whether any letters from a different Indic script appear (a wrong-language answer);
// - time per question.
// Fluency still needs native speakers to judge, which this check does not replace.
//   npm run language-check -- [--languages ta,te,bn,mr] [--questions 3] [--out report.json]
export const SCRIPTS: Record<string, RegExp> = {
  ta: /[஀-௿]/u, te: /[ఀ-౿]/u, bn: /[ঀ-৿]/u, mr: /[ऀ-ॿ]/u, hi: /[ऀ-ॿ]/u,
};
const INDIC = /[ऀ-෿]/u;
// Letters and combining marks (Indic vowel signs are marks; digits and punctuation are ignored), counted as
// target script, other Indic script, or other.
export function scriptShare(text: string, language: string) {
  const target = SCRIPTS[language];
  let mine = 0, otherIndic = 0, other = 0;
  for (const ch of text) {
    if (!/[\p{L}\p{M}]/u.test(ch)) continue; // Indic vowel signs are marks, so count them too
    if (target?.test(ch)) mine++; else if (INDIC.test(ch)) otherIndic++; else other++;
  }
  const letters = mine + otherIndic + other;
  return { letters, target: letters ? mine / letters : 0, otherIndic };
}

async function main() {
  const arg = (n: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined);
  const languages = (arg('languages')?.split(',') ?? [...REGIONAL_LANGUAGES]) as InterviewLanguage[];
  const count = Number(arg('questions') ?? 3);
  if (providerConfig().provider === 'practice') throw new Error('Set AI_PROVIDER (for example local) first.');
  const report: Record<string, unknown> = {};
  for (const language of languages) {
    const rows = [];
    for (const type of ['HR', 'Behavioral'] as const) {
      for (let i = 0; i < count; i++) {
        const started = Date.now();
        const q = await generateQuestion({ mode: 'ai', role: 'Software Development Engineer', type, difficulty: 'Intermediate', topic: type === 'HR' ? 'General' : 'Behavioral', turnIndex: i, history: [], language });
        const share = scriptShare(q.question, language);
        rows.push({ type, seconds: Math.round((Date.now() - started) / 100) / 10, targetScript: Math.round(share.target * 100), otherIndicLetters: share.otherIndic, question: q.question });
        console.log(`${language} ${type} ${i + 1}: ${Math.round(share.target * 100)}% in script, ${share.otherIndic} other-Indic letters, ${rows.at(-1)!.seconds}s: ${q.question}`);
      }
    }
    const shares = rows.map(r => r.targetScript);
    report[language] = { questions: rows.length, meanTargetScript: Math.round(shares.reduce((a, b) => a + b, 0) / shares.length), atLeast80: shares.filter(s => s >= 80).length,
      wrongScript: rows.filter(r => r.otherIndicLetters > 0).length, meanSeconds: Math.round(rows.reduce((a, r) => a + r.seconds, 0) / rows.length), rows };
  }
  console.log(JSON.stringify(Object.fromEntries(Object.entries(report).map(([k, v]) => [k, { ...(v as object), rows: undefined }])), null, 2));
  const out = arg('out'); if (out) writeFileSync(out, JSON.stringify(report, null, 2));
}
if (process.argv[1]?.endsWith('languageCheck.ts')) main().catch(err => { console.error(err instanceof Error ? err.message : 'Language check failed.'); process.exitCode = 1; });
