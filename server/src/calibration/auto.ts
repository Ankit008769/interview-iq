import { datasetHash, modelRatingSchema, RUBRIC_VERSION, criteriaFor, type CalibrationItem, type ModelRating } from './dataset.js';
import { iccA1, weightedKappa } from './stats.js';

// Automated evaluator checks for when no human raters are used. They measure two things only: whether a judge
// orders answers of known intended quality correctly, and whether two independent AI judges agree. Neither
// establishes agreement with expert interviewers, and reports say so.
export const AUTO_GATES = { ordering: 0.8, spearman: 0.6, crossJudgeIcc: 0.6, minItems: 20 };
const QUALITY_RANK = { off_topic: 0, weak: 1, adequate: 2, strong: 3 } as const;
type Quality = keyof typeof QUALITY_RANK;
type Gate = { name: string; value: number | null; threshold: number; verdict: 'pass' | 'fail' | 'insufficient data' };

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round = (x: number | null) => x === null ? null : Math.round(x * 1000) / 1000;
function ranks(xs: number[]) {
  const order = xs.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
  const out = new Array<number>(xs.length);
  for (let start = 0; start < order.length;) {
    let end = start; while (end + 1 < order.length && order[end + 1].x === order[start].x) end++;
    for (let k = start; k <= end; k++) out[order[k].i] = (start + end) / 2 + 1; // ties share their average rank
    start = end + 1;
  }
  return out;
}
export function spearman(x: number[], y: number[]): number | null {
  if (x.length < 3 || x.length !== y.length) return null;
  const rx = ranks(x), ry = ranks(y), mx = mean(rx), my = mean(ry);
  const cov = rx.reduce((a, r, i) => a + (r - mx) * (ry[i] - my), 0);
  const vx = rx.reduce((a, r) => a + (r - mx) ** 2, 0), vy = ry.reduce((a, r) => a + (r - my) ** 2, 0);
  return vx === 0 || vy === 0 ? null : cov / Math.sqrt(vx * vy);
}
// Share of item pairs with different intended quality that the judge orders the same way; a tie counts half.
export function concordance(quality: number[], score: number[]): number | null {
  let agree = 0, pairs = 0;
  for (let i = 0; i < quality.length; i++) for (let j = i + 1; j < quality.length; j++) {
    if (quality[i] === quality[j]) continue;
    pairs++;
    const d = (quality[i] - quality[j]) * (score[i] - score[j]);
    agree += d > 0 ? 1 : d === 0 ? 0.5 : 0;
  }
  return pairs ? agree / pairs : null;
}

// One judge's ratings, validated against the dataset. An item's score is the mean over its criteria, with
// "insufficient evidence" counted as 0: an answer with no evidence for a criterion is weaker than one with some.
function judgeView(items: CalibrationItem[], ratings: ModelRating[]) {
  const hash = datasetHash(items), byId = new Map(items.map(i => [i.id, i]));
  const parsed = ratings.map(r => modelRatingSchema.parse(r));
  const models = new Set(parsed.map(r => `${r.model} · ${r.promptVersion}`));
  if (models.size !== 1) throw new Error('Each ratings file must come from exactly one model and prompt version.');
  const byUnit = new Map<string, ModelRating>();
  for (const r of parsed) {
    const item = byId.get(r.itemId), key = `${r.itemId}|${r.criterionId}`;
    if (!item || byUnit.has(key) || r.rubricVersion !== RUBRIC_VERSION || (r.datasetHash && r.datasetHash !== hash)
      || !criteriaFor(item).some(c => c.id === r.criterionId) || (r.quote && !item.answer.includes(r.quote))) throw new Error('Invalid, duplicate or mismatched model rating.');
    byUnit.set(key, r);
  }
  const scored = items.filter(i => i.intendedQuality && criteriaFor(i).every(c => byUnit.has(`${i.id}|${c.id}`)));
  const itemScore = new Map(scored.map(i => [i.id, mean(criteriaFor(i).map(c => byUnit.get(`${i.id}|${c.id}`)!.score ?? 0))]));
  const quality = scored.map(i => QUALITY_RANK[i.intendedQuality as Quality]), score = scored.map(i => itemScore.get(i.id)!);
  const insufficientByQuality = Object.fromEntries((Object.keys(QUALITY_RANK) as Quality[]).map(q => {
    const units = scored.filter(i => i.intendedQuality === q).flatMap(i => criteriaFor(i).map(c => byUnit.get(`${i.id}|${c.id}`)!));
    return [q, units.length ? round(units.filter(u => u.score === null).length / units.length) : null];
  }));
  const meanByQuality = Object.fromEntries((Object.keys(QUALITY_RANK) as Quality[]).map(q => {
    const xs = scored.filter(i => i.intendedQuality === q).map(i => itemScore.get(i.id)!);
    return [q, xs.length ? round(mean(xs)) : null];
  }));
  return { model: [...models][0], byUnit, itemScore, items: scored.length,
    ordering: round(concordance(quality, score)), spearman: round(spearman(quality, score)), meanByQuality, insufficientByQuality };
}

const gate = (name: string, value: number | null, threshold: number, enough: boolean): Gate =>
  ({ name, value, threshold, verdict: !enough || value === null ? 'insufficient data' : value >= threshold ? 'pass' : 'fail' });

export function buildAutoReport(items: CalibrationItem[], a: ModelRating[], b?: ModelRating[]) {
  const judges = [judgeView(items, a), ...(b ? [judgeView(items, b)] : [])];
  if (judges.length === 2 && judges[0].model === judges[1].model) throw new Error('The second judge must be a different model or prompt.');
  const gates: Gate[] = judges.flatMap((j, n) => [
    gate(`Judge ${n + 1} orders known-quality answers (pairwise)`, j.ordering, AUTO_GATES.ordering, j.items >= AUTO_GATES.minItems),
    gate(`Judge ${n + 1} rank correlation with intended quality`, j.spearman, AUTO_GATES.spearman, j.items >= AUTO_GATES.minItems),
  ]);
  let cross = null;
  if (judges.length === 2) {
    const [j1, j2] = judges;
    const shared = items.filter(i => j1.itemScore.has(i.id) && j2.itemScore.has(i.id));
    const itemIcc = round(iccA1(shared.map(i => [j1.itemScore.get(i.id)!, j2.itemScore.get(i.id)!])));
    const pairs: [number, number][] = [];
    let bothInsufficient = 0, oneInsufficient = 0;
    for (const [key, r1] of j1.byUnit) {
      const r2 = j2.byUnit.get(key);
      if (!r2) continue;
      if (r1.score !== null && r2.score !== null) pairs.push([r1.score, r2.score]);
      else if (r1.score === null && r2.score === null) bothInsufficient++; else oneInsufficient++;
    }
    cross = { items: shared.length, itemIcc, criterionKappa: round(weightedKappa(pairs)), ratedPairs: pairs.length, bothInsufficient, oneInsufficient };
    gates.push(gate('Two independent judges agree on item scores (ICC A,1)', itemIcc, AUTO_GATES.crossJudgeIcc, shared.length >= AUTO_GATES.minItems));
  }
  return { generatedAt: new Date().toISOString(), datasetHash: datasetHash(items), rubricVersion: RUBRIC_VERSION,
    judges: judges.map(({ byUnit: _u, itemScore: _s, ...view }) => view), cross, gates,
    limits: 'Automated checks only: ordering on answers of known intended quality and agreement between AI judges. They do not show agreement with expert interviewers, and synthetic answers are easier than real ones.' };
}
export type AutoReport = ReturnType<typeof buildAutoReport>;

export function renderAutoMarkdown(r: AutoReport): string {
  const pct = (x: number | null) => x === null ? 'n/a' : x.toFixed(2);
  const lines = ['# Automated evaluator check', '', `Generated ${r.generatedAt} · dataset ${r.datasetHash.slice(0, 12)} · rubric ${r.rubricVersion}`, '', `> ${r.limits}`, '',
    '## Gates', '', '| Gate | Value | Threshold | Verdict |', '|---|---|---|---|',
    ...r.gates.map(g => `| ${g.name} | ${pct(g.value)} | ${g.threshold} | ${g.verdict} |`), ''];
  r.judges.forEach((j, n) => lines.push(`## Judge ${n + 1}: ${j.model}`, '', `Items scored: ${j.items}. Pairwise ordering ${pct(j.ordering)}; Spearman ${pct(j.spearman)}.`, '',
    '| Intended quality | Mean item score (0–5) | Insufficient-evidence share |', '|---|---|---|',
    ...(['strong', 'adequate', 'weak', 'off_topic'] as const).map(q => `| ${q} | ${pct(j.meanByQuality[q])} | ${pct(j.insufficientByQuality[q])} |`), ''));
  if (r.cross) lines.push('## Agreement between judges', '', `Items: ${r.cross.items}. Item-score ICC(A,1) ${pct(r.cross.itemIcc)}. Criterion weighted kappa ${pct(r.cross.criterionKappa)} over ${r.cross.ratedPairs} criteria both judges rated; both insufficient ${r.cross.bothInsufficient}, only one insufficient ${r.cross.oneInsufficient}.`, '');
  return lines.join('\n');
}
