import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { auditTemplate, parseAudit, parseHumanRatings, parseItems, parseModelRatings, ratingTemplate } from '../calibration/dataset.js';
import { runJudge } from '../calibration/judge.js';
import { buildReport, renderMarkdown } from '../calibration/report.js';
import { aiDisclosure } from '../services/providerConsent.js';

// Operator tool for Phase A5 calibration. See docs/CALIBRATION.md for the full process.
//   template        --items <jsonl> --rater <id> --out <csv>
//   judge           --items <jsonl> --out <jsonl> [--yes]
//   audit-template  --items <jsonl> --model <jsonl> --auditor <id> --out <csv>
//   report          --items <jsonl> --ratings <csv,csv,...> [--model <jsonl>] [--audit <csv>] --out <md>
const [command, ...rest] = process.argv.slice(2);
const args = new Map<string, string>();
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith('--')) continue;
  const key = rest[i].slice(2);
  args.set(key, rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : 'true');
}
const need = (name: string) => { const v = args.get(name); if (!v) throw new Error(`Missing --${name}.`); return v; };
const read = (path: string) => readFileSync(path, 'utf8');
const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, 'utf8'); console.log(`Wrote ${path}`); };

async function main() {
  const items = parseItems(read(need('items')));
  if (command === 'template') {
    write(need('out'), ratingTemplate(items, need('rater')));
  } else if (command === 'judge') {
    if (process.env.NODE_ENV === 'production') throw new Error('Run calibration outside the production environment.');
    const disclosure = aiDisclosure();
    if (!disclosure) throw new Error('No AI provider is configured (AI_PROVIDER is practice).');
    if (args.get('yes') !== 'true') {
      console.log(`This would send ${items.length} calibration answers to ${disclosure.provider} (${disclosure.endpoint}), judge model ${disclosure.judgeModel}. Paid usage applies. Re-run with --yes to proceed.`);
      return;
    }
    const ratings = await runJudge(items, undefined, done => process.stdout.write(`\rScored ${done}/${items.length}`));
    process.stdout.write('\n');
    write(need('out'), ratings.map(r => JSON.stringify(r)).join('\n') + '\n');
  } else if (command === 'audit-template') {
    write(need('out'), auditTemplate(items, parseModelRatings(read(need('model'))), need('auditor')));
  } else if (command === 'report') {
    const problems: string[] = [];
    const human = need('ratings').split(',').flatMap(path => { const parsed = parseHumanRatings(read(path.trim()), items); problems.push(...parsed.problems); return parsed.rows; });
    const model = args.has('model') ? parseModelRatings(read(need('model'))) : [];
    const audit = args.has('audit') ? (() => { const parsed = parseAudit(read(need('audit'))); problems.push(...parsed.problems); return parsed.rows; })() : [];
    const report = buildReport(items, human, model, audit);
    const out = need('out');
    write(out, renderMarkdown(report, problems));
    write(out.replace(/\.md$/, '') + '.json', JSON.stringify({ ...report, problems }, null, 2));
    for (const gate of report.gates) console.log(`${gate.verdict.toUpperCase().padEnd(17)} ${gate.name}`);
  } else {
    throw new Error('Usage: calibration <template|judge|audit-template|report> --items <jsonl> ... (see docs/CALIBRATION.md)');
  }
}
main().catch(err => { console.error(err instanceof Error ? err.message : 'Calibration command failed.'); process.exitCode = 1; });
