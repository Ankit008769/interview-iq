import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agreementRates, icc1, iccA1, weightedKappa } from '../src/calibration/stats.js';
import { parseCsv, writeCsv } from '../src/calibration/csv.js';
import { auditTemplate, datasetHash, modelFingerprint, parseAudit, parseHumanRatings, parseItems, parseModelRatings, ratingTemplate, type CalibrationItem, type HumanRating, type ModelRating } from '../src/calibration/dataset.js';
import { buildReport, renderMarkdown } from '../src/calibration/report.js';
import { runJudge } from '../src/calibration/judge.js';
import { rubricFor } from '../src/services/rubrics.js';

const itemsPath = fileURLToPath(new URL('../../calibration/items.synthetic.v1.jsonl', import.meta.url));
const items = parseItems(readFileSync(itemsPath, 'utf8'));
// Shrout & Fleiss (1979), Table 2: six targets rated by four judges.
const shroutFleiss = [[9, 2, 5, 8], [6, 1, 3, 2], [8, 4, 6, 8], [7, 1, 2, 6], [10, 5, 6, 9], [6, 2, 4, 7]];

describe('agreement statistics', () => {
  it('reproduce the published Shrout & Fleiss ICC values', () => {
    expect(icc1(shroutFleiss)).toBeCloseTo(0.166, 2);
    expect(iccA1(shroutFleiss)).toBeCloseTo(0.290, 2);
  });
  it('handle perfect agreement, no variance and too little data', () => {
    expect(icc1([[1, 1], [3, 3], [5, 5]])).toBeCloseTo(1);
    expect(iccA1([[1, 1], [3, 3], [5, 5]])).toBeCloseTo(1);
    expect(icc1([[2, 2], [2, 2]])).toBeNull();
    expect(icc1([[2, 3]])).toBeNull();
  });
  it('computes quadratic-weighted kappa and agreement rates', () => {
    expect(weightedKappa([[0, 0], [1, 1], [2, 3], [3, 2]], 0, 3)).toBeCloseTo(0.8);
    expect(weightedKappa([[1, 1], [4, 4], [2, 2]])).toBeCloseTo(1);
    expect(() => weightedKappa([[0, 7], [1, 1]])).toThrow();
    expect(agreementRates([[3, 3], [3, 4], [1, 4]])).toEqual({ exact: 1 / 3, withinOne: 2 / 3, meanDifference: 4 / 3 });
  });
});

describe('CSV', () => {
  it('round-trips quotes, commas, newlines, Unicode and formula-like text', () => {
    const rows = [{ a: 'He said "hi", then left', b: 'line one\nline two', c: '=SUM(A1)' }, { a: 'नमस्ते 🙂', b: '-5', c: '' }];
    const text = writeCsv(['a', 'b', 'c'], rows);
    expect(text.startsWith('﻿')).toBe(true);
    expect(text).toContain("'=SUM(A1)");
    expect(parseCsv(text)).toEqual(rows);
  });
});

describe('calibration dataset', () => {
  it('ships a valid synthetic starter set covering every interview type and quality level', () => {
    expect(items).toHaveLength(24);
    expect(new Set(items.map(i => i.type))).toEqual(new Set(['Technical', 'Behavioral', 'HR']));
    expect(new Set(items.map(i => i.intendedQuality))).toEqual(new Set(['strong', 'adequate', 'weak', 'off_topic']));
    expect(items.every(i => i.source === 'synthetic')).toBe(true);
    expect(() => parseItems('{"id":"x"}')).toThrow(/line 1/);
    expect(() => parseItems([items[0], items[0]].map(i => JSON.stringify(i)).join('\n'))).toThrow(/Duplicate/);
  });

  it('builds a blind rating sheet, shuffled per rater, with one row per item and criterion', () => {
    const sheet = parseCsv(ratingTemplate(items, 'R01'));
    const expected = items.reduce((n, i) => n + rubricFor(i.type).criteria.length, 0);
    expect(sheet).toHaveLength(expected);
    expect(Object.keys(sheet[0])).not.toContain('intendedQuality');
    expect(JSON.stringify(sheet)).not.toMatch(/model_|strong|off_topic/);
    expect(sheet.every(r => r.rater_id === 'R01' && r.score === '')).toBe(true);
    expect(parseCsv(ratingTemplate(items, 'R01')).map(r => r.item_id)).toEqual(sheet.map(r => r.item_id));
    expect(parseCsv(ratingTemplate(items, 'R02')).map(r => r.item_id)).not.toEqual(sheet.map(r => r.item_id));
  });

  it('validates ratings and keeps unfinished rows out', () => {
    const csv = writeCsv(['item_id', 'criterion_id', 'rater_id', 'score', 'evidence_quote'], [
      { item_id: 'tech-02', criterion_id: 'correctness', rater_id: 'R01', score: '4', evidence_quote: 'A linked list stores nodes' },
      { item_id: 'tech-02', criterion_id: 'depth', rater_id: 'R01', score: 'ie', evidence_quote: '' },
      { item_id: 'tech-02', criterion_id: 'approach', rater_id: 'R01', score: '', evidence_quote: '' },
      { item_id: 'tech-02', criterion_id: 'clarity', rater_id: 'R01', score: '7', evidence_quote: '' },
      { item_id: 'tech-02', criterion_id: 'correctness', rater_id: 'R01', score: '3', evidence_quote: '' },
      { item_id: 'nope', criterion_id: 'depth', rater_id: 'R01', score: '2', evidence_quote: '' },
      { item_id: 'tech-02', criterion_id: 'star', rater_id: 'R01', score: '2', evidence_quote: '' },
      { item_id: 'tech-02', criterion_id: 'tradeoffs', rater_id: 'R01', score: '2', evidence_quote: 'not in the answer' },
    ]);
    const { rows, problems } = parseHumanRatings(csv, items);
    expect(rows.map(r => [r.criterionId, r.score])).toEqual([['correctness', 4], ['depth', null], ['tradeoffs', 2]]);
    expect(problems.join('\n')).toMatch(/row 5: score must be 0–5 or IE/);
    expect(problems.join('\n')).toMatch(/row 6: duplicate/);
    expect(problems.join('\n')).toMatch(/unknown item nope/);
    expect(problems.join('\n')).toMatch(/unknown criterion star/);
    expect(problems.join('\n')).toMatch(/not an exact passage/);
  });
});

// Two raters who mostly agree, an AI judge one point generous on a few units, and an audit with one failure.
function syntheticRatings(subset: CalibrationItem[]) {
  const human: HumanRating[] = [], model: ModelRating[] = [];
  subset.forEach((item, i) => rubricFor(item.type).criteria.forEach((c, j) => {
    const base = item.intendedQuality === 'strong' ? 5 : item.intendedQuality === 'adequate' ? 3 : item.intendedQuality === 'weak' ? 1 : 0;
    const a = Math.max(0, base - ((i + j) % 2));
    const b = Math.max(0, base - ((i + j + (j % 3 === 0 ? 1 : 0)) % 2));
    human.push({ itemId: item.id, criterionId: c.id, raterId: 'R01', score: a, quote: '' }, { itemId: item.id, criterionId: c.id, raterId: 'R02', score: b, quote: '' });
    model.push({ itemId: item.id, criterionId: c.id, score: Math.min(5, a + (j === 4 ? 1 : 0)), quote: null, rationale: 'r', model: 'judge-x', promptVersion: 'evidence-judge.v1', rubricVersion: '2026-10-24.v1' });
  }));
  return { human, model };
}

describe('calibration report', () => {
  it('requires complete, fingerprinted coverage even when a large fixture meets statistical gates', () => {
    // In-memory fixtures test the gate only; these are not real licensed data or human judgments.
    const large = Array.from({length:500},(_,i)=>({...items[i%items.length],id:`fixture-${i}`,source:'licensed' as const}));
    const fixture=syntheticRatings(large), hash=datasetHash(large);
    const human=fixture.human.map(r=>({...r,datasetHash:hash}));
    const model=fixture.model.map(r=>({...r,datasetHash:hash}));
    const audit=model.map(r=>({itemId:r.itemId,criterionId:r.criterionId,auditorId:'A01',supported:'yes' as const,modelFingerprint:modelFingerprint(r)}));
    expect(buildReport(large,human,model,audit).releaseReadiness.ready).toBe(true);
    expect(buildReport(large,human.slice(1),model,audit).releaseReadiness.ready).toBe(false);
    expect(buildReport(large,human,model,audit.slice(1)).releaseReadiness.ready).toBe(false);
    expect(buildReport(large,human,model,audit.map(({modelFingerprint,...r})=>r)).releaseReadiness.ready).toBe(false);
  });
  it('rejects duplicate ratings across files, unknown claims, mixed versions and unrelated audits', () => {
    const {human, model} = syntheticRatings(items);
    expect(() => buildReport(items, [...human, human[0]], model)).toThrow(/duplicate human/);
    expect(() => buildReport(items, [{...human[0],datasetHash:'b'.repeat(64)}], model)).toThrow(/Invalid/);
    expect(() => buildReport(items, human, [...model, model[0]])).toThrow(/duplicate/);
    expect(() => buildReport(items, human, [{...model[0], itemId:'unknown'}])).toThrow(/Invalid/);
    expect(() => buildReport(items, human, [{...model[0], rubricVersion:'old'}])).toThrow(/mismatched/);
    expect(() => buildReport(items, human, [{...model[0], datasetHash:'a'.repeat(64)}])).toThrow(/mismatched/);
    expect(() => buildReport(items, human, [{...model[0], quote:'fabricated quote'}])).toThrow(/Invalid/);
    expect(() => buildReport(items, human, [model[0], {...model[1], model:'another-model'}])).toThrow(/one model/);
    const audit = {itemId:model[0].itemId,criterionId:model[0].criterionId,auditorId:'A01',supported:'yes' as const};
    expect(() => buildReport(items, human, model, [audit, audit])).toThrow(/uniquely/);
    expect(() => buildReport(items, human, model, [{...audit,itemId:'unknown'}])).toThrow(/uniquely/);
    expect(() => buildReport(items, human, model, [{...audit,modelFingerprint:'a'.repeat(64)}])).toThrow(/fingerprint/);
    expect(() => parseModelRatings(JSON.stringify({...model[0],score:9}))).toThrow(/line 1/);
    const report=buildReport(items,human,model,[audit,{...audit,auditorId:'A02',supported:'no'}]);
    expect(report.audit).toMatchObject({audited:1,unsupportedRate:1});
  });

  it('requires independent consensus and keeps synthetic statistical passes separate from release readiness', () => {
    const {human,model}=syntheticRatings(items);
    expect(buildReport(items,human.filter(r=>r.raterId==='R01'),model).judge?.scoredPairs).toBe(0);
    const split=human.map(r=>r.raterId==='R02'?{...r,score:null}:r);
    expect(buildReport(items,split,model).judge?.scoredPairs).toBe(0);
    const bound=model.map(m=>({...m,datasetHash:datasetHash(items)}));
    const audit=bound.map(m=>({itemId:m.itemId,criterionId:m.criterionId,auditorId:'A01',supported:'yes' as const}));
    const report=buildReport(items,human,bound,audit);
    expect(report.gates.every(g=>g.verdict==='pass')).toBe(true);
    expect(report.releaseReadiness.ready).toBe(false);
    expect(report.releaseReadiness.blockers.join(' ')).toContain('500');
    expect(renderMarkdown(report)).toContain('**not ready**');
  });
  it('passes the gates when agreement is high and flags failures and thin data', () => {
    const { human, model } = syntheticRatings(items);
    const audit = model.slice(0, 40).map((m, i) => ({ itemId: m.itemId, criterionId: m.criterionId, auditorId: 'A01', supported: (i === 0 ? 'no' : 'yes') as 'yes' | 'no' }));
    const report = buildReport(items, human, model, audit);
    expect(report.human.scoredPairs).toBe(report.units);
    expect(report.human.icc!).toBeGreaterThan(0.7);
    expect(report.judge!.icc!).toBeGreaterThan(0.6);
    expect(report.audit!.unsupportedRate).toBeCloseTo(1 / 40);
    expect(report.gates.map(g => g.verdict)).toEqual(['pass', 'pass', 'pass']);
    const [strong, adequate, weak, offTopic] = report.intended.map(x => x.meanConsensus!);
    expect(strong > adequate && adequate > weak && weak > offTopic).toBe(true);
    const markdown = renderMarkdown(report, ['rating row 9: example problem']);
    expect(markdown).toMatch(/\| Human–human agreement \(ICC 1,1\) \| ≥ 0\.7 \| \d\.\d\d \| \d+ \| \*\*pass\*\* \|/);
    expect(markdown).toContain('## Input problems');

    const thin = buildReport(items.slice(0, 3), syntheticRatings(items.slice(0, 3)).human);
    expect(thin.gates[0].verdict).toBe('insufficient data');
    expect(thin.judge).toBeNull();
    const reversed = human.map(r => r.raterId === 'R02' && r.score !== null ? { ...r, score: 5 - r.score } : r);
    expect(buildReport(items, reversed).gates[0].verdict).toBe('fail');
  });

  it('excludes insufficient-evidence ratings from ICC and reports them separately', () => {
    const item = items[0];
    const human: HumanRating[] = rubricFor(item.type).criteria.flatMap(c => [
      { itemId: item.id, criterionId: c.id, raterId: 'R01', score: null, quote: '' },
      { itemId: item.id, criterionId: c.id, raterId: 'R02', score: c.id === 'depth' ? 3 : null, quote: '' }]);
    const report = buildReport([item], human);
    expect(report.human.scoredPairs).toBe(0);
    expect(report.human.ieAgreement).toBeCloseTo(4 / 5);
  });
});

describe('AI judge run and audit sheet', () => {
  it('scores each item as a one-answer interview through the evaluator', async () => {
    const calls: any[] = [];
    const ratings = await runJudge(items.slice(0, 2), async ctx => {
      calls.push(ctx);
      const rubric = rubricFor(ctx.type);
      return { source: 'ai', score: 60, summary: '', strengths: [], improvements: [], nextSteps: [], rubric,
        answers: [{ questionIndex: 0, criteria: rubric.criteria.map(c => ({ criterionId: c.id, label: c.label, score: 3, status: 'rated' as const,
          rationale: 'ok', improvement: null, evidence: { quote: ctx.history[0].answer.slice(0, 10), start: 0, end: 10 } })) }],
        generation: { provider: 'test', model: 'judge-x', promptVersion: 'evidence-judge.v1', inputHash: 'h', inputTokens: 1, outputTokens: 1, latencyMs: 1 } };
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ mode: 'ai', type: items[0].type, history: [{ question: items[0].question, answer: items[0].answer }] });
    expect(ratings).toHaveLength(10);
    expect(ratings[0]).toMatchObject({ itemId: items[0].id, score: 3, model: 'judge-x', rubricVersion: '2026-10-24.v1' });
    await expect(runJudge(items.slice(0, 1), async () => ({ source: 'ai', score: null, summary: '', strengths: [], improvements: [], nextSteps: [] }))).rejects.toThrow(/no scorecard/);

    const sheet = parseCsv(auditTemplate(items, [...ratings, { ...ratings[0], criterionId: 'depth', score: null }], 'A01'));
    expect(sheet).toHaveLength(10);
    expect(sheet[0]).toMatchObject({ item_id: items[0].id, model_score: '3', auditor_id: 'A01', supported: '' });
    const filled = writeCsv(['item_id', 'criterion_id', 'auditor_id', 'supported'], [{ item_id: 'a', criterion_id: 'b', auditor_id: 'A01', supported: 'Partly' }, { supported: 'maybe' }]);
    const audit = parseAudit(filled);
    expect(audit.rows).toEqual([{ itemId: 'a', criterionId: 'b', auditorId: 'A01', supported: 'partly' }]);
    expect(audit.problems).toHaveLength(1);
  });
});

describe('calibration command line', () => {
  it('writes a template, refuses a paid judge run without a provider, and produces a report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iq-calibration-'));
    const run = (...args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', 'src/scripts/calibration.ts', ...args],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, AI_PROVIDER: 'practice' }, encoding: 'utf8', stdio: 'pipe' });
    run('template', '--items', itemsPath, '--rater', 'R01', '--out', join(dir, 'R01.csv'));
    const sheet = parseCsv(readFileSync(join(dir, 'R01.csv'), 'utf8'));
    expect(sheet.length).toBeGreaterThan(100);
    expect(() => run('judge', '--items', itemsPath, '--out', join(dir, 'model.jsonl'))).toThrow(/No AI provider/);

    const { human } = syntheticRatings(items);
    for (const rater of ['R01', 'R02']) writeFileSync(join(dir, `${rater}.csv`), writeCsv(['item_id', 'criterion_id', 'rater_id', 'score', 'evidence_quote'],
      human.filter(r => r.raterId === rater).map(r => ({ item_id: r.itemId, criterion_id: r.criterionId, rater_id: r.raterId, score: r.score ?? 'IE', evidence_quote: '' }))));
    const output = run('report', '--items', itemsPath, '--ratings', `${join(dir, 'R01.csv')},${join(dir, 'R02.csv')}`, '--out', join(dir, 'report.md'));
    expect(output).toMatch(/PASS\s+Human–human agreement/);
    expect(output).toMatch(/INSUFFICIENT DATA\s+AI judge/);
    expect(readFileSync(join(dir, 'report.md'), 'utf8')).toContain('# InterviewIQ evaluator calibration report');
    expect(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')).raters).toEqual(['R01', 'R02']);
    expect(() => run('report', '--items', itemsPath, '--ratings', `${join(dir, 'R01.csv')},${join(dir, 'R01.csv')}`, '--out', join(dir, 'duplicate.md'))).toThrow(/duplicate human/);
    expect(() => run('template', '--items', itemsPath, '--rater', 'R02', '--out', join(dir, 'R01.csv'))).toThrow(/already exists/);
  }, 60_000);
});
