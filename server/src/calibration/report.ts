import { agreementRates, icc1, iccA1, weightedKappa } from './stats.js';
import { criteriaFor, datasetHash, modelFingerprint, modelRatingSchema, RUBRIC_VERSION, type AuditRow, type CalibrationItem, type HumanRating, type ModelRating } from './dataset.js';

// Phase A gates from the strategy report (section 10.2). A verdict needs at least minUnits rated units.
export const GATES = { humanIcc: 0.7, judgeIcc: 0.6, unsupportedRate: 0.05, minUnits: 30 };

type Unit = { itemId: string; criterionId: string; group: string; quality?: string; human: HumanRating[]; model?: ModelRating };
type Gate = { name: string; target: string; value: number | null; units: number; verdict: 'pass' | 'fail' | 'insufficient data' };

const average = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
// Mean of the balanced pair, null when both chose IE, undefined without consensus.
function consensus(unit: Unit): number | null | undefined {
  if (unit.human.length < 2) return undefined;
  const panel = [...unit.human].sort((a, b) => a.raterId.localeCompare(b.raterId)).slice(0, 2);
  const scored = panel.flatMap(r => r.score === null ? [] : [r.score]);
  // A split numeric/IE pair has no consensus; do not silently discard the IE vote.
  if (scored.length === 1) return undefined;
  return average(scored);
}

function panel(units: Unit[]) {
  const pairs: [number, number][] = [];
  let anyIe = 0, bothIe = 0, doubly = 0;
  for (const unit of units) {
    // Two ratings per unit keep the design balanced; the first two by rater ID are used.
    const [a, b] = [...unit.human].sort((x, y) => x.raterId.localeCompare(y.raterId));
    if (!a || !b) continue;
    doubly++;
    if (a.score === null || b.score === null) { anyIe++; if (a.score === null && b.score === null) bothIe++; }
    else pairs.push([a.score, b.score]);
  }
  const rates = agreementRates(pairs);
  return { units: doubly, scoredPairs: pairs.length, icc: icc1(pairs), kappa: weightedKappa(pairs),
    exact: rates.exact, withinOne: rates.withinOne, ieAgreement: anyIe ? bothIe / anyIe : null };
}

function judge(units: Unit[]) {
  const pairs: [number, number][] = [];
  let compared = 0, modelIeWhenHumansScored = 0, modelScoredWhenHumansIe = 0;
  for (const unit of units) {
    const human = consensus(unit);
    if (!unit.model || human === undefined) continue;
    compared++;
    if (human !== null && unit.model.score !== null) pairs.push([human, unit.model.score]);
    else if (human !== null) modelIeWhenHumansScored++;
    else if (unit.model.score !== null) modelScoredWhenHumansIe++;
  }
  const rates = agreementRates(pairs);
  return { units: compared, scoredPairs: pairs.length, icc: iccA1(pairs), withinOne: rates.withinOne,
    meanDifference: rates.meanDifference, modelIeWhenHumansScored, modelScoredWhenHumansIe };
}

const verdict = (value: number | null, units: number, ok: (v: number) => boolean): Gate['verdict'] =>
  value === null || units < GATES.minUnits ? 'insufficient data' : ok(value) ? 'pass' : 'fail';

export function buildReport(items: CalibrationItem[], human: HumanRating[], model: ModelRating[] = [], audit: AuditRow[] = []) {
  if (!items.length || new Set(items.map(i => i.id)).size !== items.length) throw new Error('A non-empty unique dataset is required.');
  const hash = datasetHash(items), byId = new Map(items.map(i => [i.id, i]));
  const units = new Map<string, Unit>();
  for (const item of items) for (const c of criteriaFor(item)) {
    units.set(`${item.id}|${c.id}`, { itemId: item.id, criterionId: c.id, group: `${item.type} · ${c.label}`, quality: item.intendedQuality, human: [] });
  }
  const seenHuman = new Set<string>();
  for (const r of human) {
    const unit = units.get(`${r.itemId}|${r.criterionId}`), key = `${r.itemId}|${r.criterionId}|${r.raterId}`;
    if (!unit || !r.raterId.trim() || seenHuman.has(key) || (r.score !== null && (!Number.isInteger(r.score) || r.score < 0 || r.score > 5)) ||
        (r.datasetHash && r.datasetHash !== hash) ||
        (r.quote && !byId.get(r.itemId)!.answer.includes(r.quote))) throw new Error('Invalid or duplicate human rating; check all input files.');
    seenHuman.add(key); unit.human.push(r);
  }
  for (const raw of model) {
    const m = modelRatingSchema.parse(raw), unit = units.get(`${m.itemId}|${m.criterionId}`);
    if (!unit || unit.model || m.rubricVersion !== RUBRIC_VERSION || (m.datasetHash && m.datasetHash !== hash) ||
        (m.quote && !byId.get(m.itemId)!.answer.includes(m.quote))) throw new Error('Invalid, duplicate or mismatched model rating.');
    unit.model = m;
  }
  if (new Set(model.map(m => `${m.model}|${m.promptVersion}|${m.rubricVersion}`)).size > 1) throw new Error('Use one model, prompt and rubric per calibration report.');
  const auditSeen = new Set<string>(), audited = new Map<string, AuditRow>();
  const severity = { yes: 0, partly: 1, no: 2 };
  for (const a of audit) {
    const key = `${a.itemId}|${a.criterionId}`, identity = `${key}|${a.auditorId}`, m = units.get(key)?.model;
    if (!m || m.score === null || !a.auditorId?.trim() || auditSeen.has(identity) || !(a.supported in severity)) throw new Error('Audit must uniquely reference a scored model rating and an auditor.');
    if (a.modelFingerprint && a.modelFingerprint !== modelFingerprint(m)) throw new Error('Audit fingerprint does not match this model response; generate a new audit sheet.');
    auditSeen.add(identity);
    const previous = audited.get(key);
    if (!previous || severity[a.supported] > severity[previous.supported]) audited.set(key, a);
  }
  // Count each claim once, using the most conservative review when auditors disagree.
  const allAuditsBound = audit.every(a => Boolean(a.modelFingerprint));
  audit = [...audited.values()];
  const all = [...units.values()];
  const groups = [...new Set(all.map(u => u.group))];
  const humanPanel = panel(all);
  const judgeAll = model.length ? judge(all) : null;
  const no = audit.filter(a => a.supported === 'no').length;
  const partly = audit.filter(a => a.supported === 'partly').length;
  const auditSummary = audit.length ? { audited: audit.length, unsupportedRate: no / audit.length, partlyRate: partly / audit.length } : null;
  const intended = (['strong', 'adequate', 'weak', 'off_topic'] as const).map(quality => {
    const scores = all.filter(u => u.quality === quality).flatMap(u => { const c = consensus(u); return typeof c === 'number' ? [c] : []; });
    return { quality, units: scores.length, meanConsensus: average(scores) };
  }).filter(x => x.units);
  const gates: Gate[] = [
    { name: 'Human–human agreement (ICC 1,1)', target: `≥ ${GATES.humanIcc}`, value: humanPanel.icc, units: humanPanel.scoredPairs,
      verdict: verdict(humanPanel.icc, humanPanel.scoredPairs, v => v >= GATES.humanIcc) },
    { name: 'AI judge vs human consensus (ICC A,1)', target: `≥ ${GATES.judgeIcc}`, value: judgeAll?.icc ?? null, units: judgeAll?.scoredPairs ?? 0,
      verdict: verdict(judgeAll?.icc ?? null, judgeAll?.scoredPairs ?? 0, v => v >= GATES.judgeIcc) },
    { name: 'Unsupported AI claims (audit)', target: `< ${GATES.unsupportedRate * 100}%`, value: auditSummary?.unsupportedRate ?? null, units: auditSummary?.audited ?? 0,
      verdict: verdict(auditSummary?.unsupportedRate ?? null, auditSummary?.audited ?? 0, v => v < GATES.unsupportedRate) },
  ];
  const blockers: string[] = [];
  const realItems = items.filter(i => i.source !== 'synthetic').length;
  if (realItems < 500) blockers.push('At least 500 licensed or research-consented real answers are required; synthetic pilot results are not a release validation.');
  if (all.some(u => u.human.length < 2)) blockers.push('Every criterion needs two independent human ratings.');
  if (human.some(r => r.datasetHash !== hash)) blockers.push('Human rating sheets must carry the matching dataset fingerprint.');
  if (all.some(u => !u.model)) blockers.push('Every criterion needs a model rating; incomplete runs cannot validate a release.');
  if (!model.length || model.some(m => m.datasetHash !== hash)) blockers.push('Model ratings must carry the matching dataset fingerprint.');
  if (!allAuditsBound) blockers.push('Audit sheets must carry fingerprints matching the exact model responses.');
  if (all.some(u => u.model?.score !== null && u.model && !audited.has(`${u.itemId}|${u.criterionId}`))) blockers.push('Every scored model claim needs an evidence audit.');
  if (gates.some(g => g.verdict !== 'pass')) blockers.push('All three statistical gates must pass.');
  return {
    generatedAt: new Date().toISOString(), datasetHash: hash, rubricVersion: RUBRIC_VERSION, items: items.length, units: all.length,
    releaseReadiness: { ready: blockers.length === 0, realItems, blockers },
    sources: [...new Set(items.map(i => i.source))], raters: [...new Set(human.map(r => r.raterId))].sort(), ratings: human.length,
    models: [...new Set(model.map(m => `${m.model} · ${m.promptVersion} · rubric ${m.rubricVersion}`))],
    human: humanPanel, judge: judgeAll, audit: auditSummary, intended, gates,
    byCriterion: groups.map(group => { const subset = all.filter(u => u.group === group); return { group, human: panel(subset), judge: model.length ? judge(subset) : null }; }),
  };
}
export type CalibrationReport = ReturnType<typeof buildReport>;

const num = (v: number | null | undefined, digits = 2) => v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(digits);
const pct = (v: number | null | undefined) => v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`;

export function renderMarkdown(report: CalibrationReport, problems: string[] = []): string {
  const lines = [
    '# InterviewIQ evaluator calibration report', '',
    `Generated ${report.generatedAt} · rubric ${report.rubricVersion} · ${report.items} items (${report.sources.join(', ')}) · ${report.units} rated units`,
    `Raters: ${report.raters.join(', ') || 'none'} (${report.ratings} ratings) · AI judge: ${report.models.join('; ') || 'not included'}`, '',
    `Release readiness: **${report.releaseReadiness.ready ? 'eligible for human release review' : 'not ready'}**`,
    ...report.releaseReadiness.blockers.map(b => `- ${b}`), '',
    `Dataset fingerprint: ${report.datasetHash}`, '',
    '## Gates', '', '| Gate | Target | Value | Units | Verdict |', '|---|---|---|---|---|',
    ...report.gates.map(g => `| ${g.name} | ${g.target} | ${g.name.startsWith('Unsupported') ? pct(g.value) : num(g.value)} | ${g.units} | **${g.verdict}** |`), '',
    `A verdict needs at least ${GATES.minUnits} scored units. Phase C raises the AI judge target to ICC ≥ 0.75.`, '',
    '## Human panel', '',
    `ICC(1,1) ${num(report.human.icc)} · quadratic-weighted κ ${num(report.human.kappa)} · exact ${pct(report.human.exact)} · within one point ${pct(report.human.withinOne)} · both chose "insufficient evidence" when either did: ${pct(report.human.ieAgreement)} · ${report.human.units} double-rated units`, '',
    '| Criterion | Units | ICC | κ | Exact | ±1 |', '|---|---|---|---|---|---|',
    ...report.byCriterion.map(c => `| ${c.group} | ${c.human.scoredPairs} | ${num(c.human.icc)} | ${num(c.human.kappa)} | ${pct(c.human.exact)} | ${pct(c.human.withinOne)} |`), '',
  ];
  if (report.judge) lines.push('## AI judge vs human consensus', '',
    `ICC(A,1) ${num(report.judge.icc)} · within one point ${pct(report.judge.withinOne)} · mean difference (AI − humans) ${num(report.judge.meanDifference)} · AI said "insufficient evidence" where humans scored: ${report.judge.modelIeWhenHumansScored} · AI scored where humans said "insufficient evidence": ${report.judge.modelScoredWhenHumansIe}`, '',
    '| Criterion | Units | ICC | ±1 | Mean diff |', '|---|---|---|---|---|',
    ...report.byCriterion.map(c => `| ${c.group} | ${c.judge?.scoredPairs ?? 0} | ${num(c.judge?.icc)} | ${pct(c.judge?.withinOne)} | ${num(c.judge?.meanDifference)} |`), '');
  if (report.audit) lines.push('## Evidence audit', '',
    `${report.audit.audited} AI ratings audited · unsupported ${pct(report.audit.unsupportedRate)} · partly supported ${pct(report.audit.partlyRate)}`, '');
  if (report.intended.length) lines.push('## Sanity check by intended quality', '', '| Intended quality | Units | Mean human score |', '|---|---|---|',
    ...report.intended.map(x => `| ${x.quality} | ${x.units} | ${num(x.meanConsensus)} |`), '',
    'Strong answers should score clearly above weak ones. If not, review the rubric anchors or the item set before trusting agreement figures.', '');
  if (problems.length) lines.push('## Input problems', '', ...problems.map(p => `- ${p}`), '');
  lines.push('## Reading this report', '',
    '- ICC measures absolute agreement on the 0–5 scale; 0.75+ is good, 0.5–0.75 moderate, below 0.5 poor.',
    '- Low human–human agreement usually means the rubric or anchors are ambiguous: fix those before judging the AI.',
    '- Units where a rater chose "insufficient evidence" are excluded from ICC and reported separately.',
    '- Synthetic items are for piloting the process; release decisions need licensed or research-consented real answers.');
  return lines.join('\n') + '\n';
}
