import { readFileSync } from 'node:fs';
import mongoose from 'mongoose';
import { ingestZip } from '../projects/ingest.js';
import { findDependencies, indexSymbols } from '../projects/codeIndex.js';
import { generateQuestion } from '../services/ai.js';
import { providerConfig } from '../services/providerConfig.js';
import type { AnswerTurn } from '../models/Interview.js';

// Operator check of project defense (C4 exit gate) with the configured model: how often the model itself names
// the file or function a question is about (before the app adds the reference), whether every reference is a
// real symbol, and how long each question takes. Uses no database and no user data.
//   npm run project-check -- path/to/project.zip [--questions 10]
async function main() {
  const [zipPath] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const count = Number(process.argv[process.argv.indexOf('--questions') + 1]) || 10;
  if (!zipPath) throw new Error('Pass the path of a project zip.');
  const config = providerConfig();
  if (config.provider === 'practice') throw new Error('Set AI_PROVIDER (for example local) first.');
  const ingested = await ingestZip(readFileSync(zipPath));
  const project = { _id: new mongoose.Types.ObjectId(), name: zipPath.split(/[\\/]/).at(-1)!.replace(/\.zip$/, ''), files: ingested.files,
    symbols: await indexSymbols(ingested.files), dependencies: findDependencies(ingested.files) };
  console.log(`Project: ${project.files.length} files, ${project.symbols.length} symbols, ${project.dependencies.length} dependencies, ${ingested.secrets.length + ingested.secretFiles.length} secrets removed. Model ${config.interviewerModel}.`);
  const history: AnswerTurn[] = [];
  let named = 0, real = 0;
  for (let i = 0; i < count; i++) {
    const started = Date.now();
    const q = await generateQuestion({ mode: 'ai', role: 'Software Development Engineer', type: 'Technical', difficulty: 'Intermediate', topic: `Project: ${project.name}`,
      turnIndex: i, history, project });
    const code = q.grounding?.code;
    if (!code) { console.log(`${i + 1}. no target left`); break; }
    if (code.referenced === 'model') named++;
    if (project.symbols.some(s => s.path === code.path && s.name === code.symbol)) real++;
    console.log(`${i + 1}. [${code.referenced}] ${((Date.now() - started) / 1000).toFixed(1)}s ${code.path}#${code.symbol}: ${q.question}`);
    history.push({ question: q.question, answer: 'I would rather explain it in the next question.', topic: q.topic, answeredAt: new Date(), grounding: q.grounding });
  }
  const asked = history.length;
  console.log(`Named by the model: ${named}/${asked} (${Math.round(100 * named / Math.max(1, asked))}%). Real symbols: ${real}/${asked}.`);
}
main().catch(err => { console.error(err instanceof Error ? err.message : 'Project check failed.'); process.exitCode = 1; });
