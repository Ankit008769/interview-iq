import { createHash } from 'node:crypto';
import { BillingEvent, Payment, Subscription, type Provider } from '../models/Billing.js';
import { csvRecords } from '../services/csv.js';
import { PLANS } from './plans.js';

const DAY = 86_400_000;

// ---------------------------------------------------------------- reconciliation (D5 exit gate: 100%)

export type ProviderRow = { id: string; amount: number; currency: string; status: 'captured' | 'refunded' | 'partially_refunded' | 'failed' | 'other'; refunded: number };
const ID_COLUMNS = ['payment_intent_id', 'paymentintent_id', 'payment_id', 'entity_id', 'id'];
// Reads a provider's payments export. Exports show major units (rupees, dollars) unless `minorUnits` is set.
export function readProviderCsv(text: string, minorUnits = false): ProviderRow[] {
  const toMinor = (v: string) => { const n = Number((v || '0').replace(/[^0-9.-]/g, '')); return Math.round(minorUnits ? n : n * 100); };
  return csvRecords(text).map(r => {
    const id = ID_COLUMNS.map(c => r[c]).find(Boolean) ?? '';
    const s = (r.status ?? '').toLowerCase();
    const refunded = toMinor(r.amount_refunded ?? r.refunded ?? '0');
    const amount = toMinor(r.amount ?? '0');
    const status: ProviderRow['status'] = /fail/.test(s) ? 'failed' : refunded >= amount && amount > 0 ? 'refunded' : refunded > 0 ? 'partially_refunded' : /captured|paid|succeeded|settled/.test(s) ? 'captured' : 'other';
    return { id, amount, currency: (r.currency ?? 'INR').toUpperCase(), status, refunded };
  }).filter(r => r.id);
}

export async function reconcile(provider: Provider, rows: ProviderRow[], from: Date, to: Date, now = new Date()) {
  const local = await Payment.find({ provider, capturedAt: { $gte: from, $lt: to } }).lean();
  const byId = new Map(local.map(p => [p.providerPaymentId, p]));
  const seen = new Set<string>();
  const differences = { missingLocally: [] as string[], missingAtProvider: [] as string[], amountMismatch: [] as string[], refundMismatch: [] as string[] };
  let matched = 0;
  for (const row of rows.filter(r => r.status !== 'failed' && r.status !== 'other')) {
    seen.add(row.id);
    const p = byId.get(row.id) ?? await Payment.findOne({ provider, providerPaymentId: row.id }).lean();
    if (!p) { differences.missingLocally.push(row.id); continue; }
    if (p.amount !== row.amount || p.currency !== row.currency) { differences.amountMismatch.push(row.id); continue; }
    if (p.refunded !== row.refunded) { differences.refundMismatch.push(row.id); continue; }
    matched++;
  }
  for (const p of local) if (!seen.has(p.providerPaymentId)) differences.missingAtProvider.push(p.providerPaymentId);
  const uninvoiced = local.filter(p => p.currency === 'INR' && !p.invoiceId).map(p => p.providerPaymentId);
  const stuckEvents = await BillingEvent.countDocuments({ provider, outcome: { $in: ['failed', 'processing'] }, receivedAt: { $lt: new Date(now.getTime() - 3_600_000) } });
  const total = Object.values(differences).reduce((n, l) => n + l.length, 0);
  return { provider, from: from.toISOString(), to: to.toISOString(), providerRows: rows.length, localPayments: local.length, matched,
    reconciled: total === 0 && stuckEvents === 0, differences, uninvoicedInrPayments: uninvoiced, stuckWebhookEvents: stuckEvents };
}

// ---------------------------------------------------------------- revenue metrics (D5 exit gate dashboards)

// Monthly recurring revenue by currency, ARPU, churn, LTV and CAC for a window. Amounts are in minor units.
export async function revenueMetrics(input: { from: Date; to: Date; grossMargin?: number; marketingSpend?: number }) {
  const { from, to } = input;
  const margin = input.grossMargin ?? 0.75;
  const live = (at: Date) => ({ createdAt: { $lte: at }, currentPeriodEnd: { $gt: at }, status: { $in: ['active', 'past_due', 'cancelled'] } });
  const [atStart, atEnd, payments, firstPayments] = await Promise.all([
    Subscription.find(live(from)).lean(), Subscription.find(live(to)).lean(),
    Payment.find({ capturedAt: { $gte: from, $lt: to } }).lean(),
    Payment.aggregate<{ _id: unknown; first: Date }>([{ $match: { userId: { $exists: true } } }, { $group: { _id: '$userId', first: { $min: '$capturedAt' } } }, { $match: { first: { $gte: from, $lt: to } } }]),
  ]);
  const monthly = (s: { plan: 'pro' | 'pro_plus'; interval: 'month' | 'year' }) => (s.interval === 'month' ? PLANS[s.plan].prices.month! : Math.round(PLANS[s.plan].prices.year! / 12));
  // List prices are INR; subscriptions billed through Stripe are reported separately at INR list price.
  const mrr = atEnd.reduce((n, s) => n + monthly(s), 0);
  const revenue: Record<string, number> = {};
  for (const p of payments) revenue[p.currency] = (revenue[p.currency] ?? 0) + p.amount - p.refunded;
  const payers = new Set(payments.filter(p => p.userId).map(p => String(p.userId))).size;
  const months = Math.max(1, (to.getTime() - from.getTime()) / (30 * DAY));
  const startIds = new Set(atStart.map(s => String(s._id)));
  const stillLive = atEnd.filter(s => startIds.has(String(s._id))).length;
  const churn = atStart.length ? (atStart.length - stillLive) / atStart.length / months : null;
  const inr = revenue.INR ?? 0;
  const arpuMonthly = payers ? Math.round(inr / payers / months) : null;
  const ltv = arpuMonthly !== null && churn ? Math.round(arpuMonthly * margin / churn) : null;
  const cac = input.marketingSpend !== undefined && firstPayments.length ? Math.round(input.marketingSpend / firstPayments.length) : null;
  return { from: from.toISOString(), to: to.toISOString(), activeSubscriptions: atEnd.length, mrrInr: mrr, arrInr: mrr * 12, revenue, payingUsers: payers,
    newPayingUsers: firstPayments.length, arpuMonthlyInr: arpuMonthly, monthlyChurn: churn === null ? null : Math.round(churn * 1000) / 1000,
    grossMargin: margin, ltvInr: ltv, cacInr: cac, ltvToCac: ltv !== null && cac ? Math.round(ltv / cac * 10) / 10 : null };
}

// Rows for BigQuery (newline-delimited JSON). User IDs are replaced by a salted hash.
export async function analyticsRows(salt: string) {
  if (salt.length < 16) throw new Error('BILLING_EXPORT_SALT must be at least 16 characters.');
  const pseudo = (id?: unknown) => (id ? createHash('sha256').update(`${salt}:${String(id)}`).digest('hex').slice(0, 32) : null);
  const [payments, subscriptions] = await Promise.all([Payment.find().lean(), Subscription.find().lean()]);
  return {
    payments: payments.map(p => ({ payment_id: String(p._id), user: pseudo(p.userId), org: p.orgId ? String(p.orgId) : null, provider: p.provider, kind: p.kind, plan: p.plan ?? null,
      pack: p.packId ?? null, amount_minor: p.amount, refunded_minor: p.refunded, currency: p.currency, captured_at: p.capturedAt.toISOString(), invoiced: !!p.invoiceId })),
    subscriptions: subscriptions.map(s => ({ subscription_id: String(s._id), user: pseudo(s.userId), provider: s.provider, plan: s.plan, interval: s.interval, status: s.status,
      created_at: s.createdAt.toISOString(), current_period_end: s.currentPeriodEnd?.toISOString() ?? null, cancel_at_period_end: s.cancelAtPeriodEnd })),
  };
}
