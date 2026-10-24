import { z } from 'zod';
const rateSchema = z.object({
  version: z.string().min(1).max(100), provider: z.enum(['openai', 'compatible']),
  endpoint: z.string().url(), model: z.string().min(1), slot: z.enum(['interviewer', 'judge']),
  source: z.string().url(), validFrom: z.string().datetime(), validUntil: z.string().datetime(),
  inputUsdPerMillion: z.number().finite().nonnegative().max(100000),
  outputUsdPerMillion: z.number().finite().nonnegative().max(100000),
  cachedInputUsdPerMillion: z.number().finite().nonnegative().max(100000).optional(),
}).strict().refine(r => Date.parse(r.validUntil) > Date.parse(r.validFrom), 'Invalid rate interval');
export type Rate = z.infer<typeof rateSchema>;
export type CostEstimate = { amountUsd: number | null; reason: string; rate?: Rate };
export function readRateCard(): Rate[] {
  try {
    const rates = z.array(rateSchema).max(200).parse(JSON.parse(process.env.AI_RATE_CARD_JSON || '[]'));
    for (const [i, a] of rates.entries()) {
      const url = new URL(a.endpoint);
      if (url.username || url.password || url.search || url.hash) throw new Error();
      if (rates.slice(i + 1).some(b => a.provider === b.provider && a.endpoint === b.endpoint && a.model === b.model && a.slot === b.slot
        && Date.parse(a.validFrom) < Date.parse(b.validUntil) && Date.parse(b.validFrom) < Date.parse(a.validUntil))) throw new Error();
    }
    return rates;
  } catch { throw new Error('Invalid AI_RATE_CARD_JSON: check rates, validity intervals and overlapping entries.'); }
}
export function estimateCost(rates: Rate[], usage: { provider: string; endpoint?: string; model: string; slot: string;
  inputTokens: number | null; outputTokens: number | null; cachedInputTokens?: number; cancelled?: boolean; at: Date }): CostEstimate {
  if (usage.cancelled) return { amountUsd: 0, reason: 'cancelled_before_dispatch' };
  if (usage.slot === 'transcriber') return { amountUsd: null, reason: 'unsupported_audio_pricing' };
  const rate = rates.find(r => r.provider === usage.provider && r.endpoint === usage.endpoint && r.model === usage.model && r.slot === usage.slot
    && Date.parse(r.validFrom) <= usage.at.getTime() && usage.at.getTime() < Date.parse(r.validUntil));
  if (!rate) return { amountUsd: null, reason: 'no_matching_rate' };
  const { inputTokens: input, outputTokens: output } = usage;
  const cached = usage.cachedInputTokens ?? 0;
  if (input === null || output === null || ![input, output, cached].every(n => Number.isSafeInteger(n) && n >= 0) || cached > input)
    return { amountUsd: null, reason: 'unknown_usage', rate };
  if (cached > 0 && rate.cachedInputUsdPerMillion === undefined) return { amountUsd: null, reason: 'missing_cached_rate', rate };
  const amount = ((input - cached) * rate.inputUsdPerMillion + cached * (rate.cachedInputUsdPerMillion ?? 0) + output * rate.outputUsdPerMillion) / 1000000;
  return { amountUsd: Number(amount.toFixed(12)), reason: 'estimated', rate };
}

// Offline comparison with an operator-supplied USD subtotal for exactly the same
// account/provider/model/window. Never mutates usage or treats an estimate as a bill.
export function reconcileUsage(input: unknown, scope: { provider: string; model: string; from: string; to: string; billedUsd: number }) {
  const entries = z.array(z.object({ _id: z.string(), provider: z.string().optional(), model: z.string().optional(), createdAt: z.string().datetime(),
    cost: z.object({ amountUsd: z.number().finite().nonnegative().nullable().optional() }).optional() })).parse(input);
  z.string().datetime().parse(scope.from); z.string().datetime().parse(scope.to);
  const from = Date.parse(scope.from), to = Date.parse(scope.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || !Number.isFinite(scope.billedUsd) || scope.billedUsd < 0) throw new Error('Invalid billing scope.');
  if (new Set(entries.map(e=>e._id)).size !== entries.length) throw new Error('Duplicate usage receipts.');
  const selected = entries.filter(e=>e.provider===scope.provider && e.model===scope.model && Date.parse(e.createdAt)>=from && Date.parse(e.createdAt)<to);
  if (!selected.length) throw new Error('No usage receipts match the supplied scope.');
  const unknownCostAttempts = selected.filter(e=>e.cost?.amountUsd == null).length;
  const estimatedCostUsd = Number(selected.reduce((sum,e)=>sum+(e.cost?.amountUsd??0),0).toFixed(12));
  return { ...scope, currency: 'USD', attempts: selected.length, unknownCostAttempts, estimatedCostUsd,
    differenceUsd: unknownCostAttempts ? null : Number((scope.billedUsd-estimatedCostUsd).toFixed(12)),
    note: 'Operator asserted matching scope. Difference is not an attribution or invoice validation; inspect discounts, taxes, missing receipts and unreported provider charges.' };
}
