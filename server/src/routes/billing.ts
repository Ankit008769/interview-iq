import express, { Router, type Request, type Response, type NextFunction } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { Credit, Invoice, Payment, Referral, Subscription, PROVIDERS, type IInvoice, type Provider } from '../models/Billing.js';
import { usage } from '../billing/entitlements.js';
import { CAMPUS_TIERS, CAMPUS_VOICE_PER_YEAR, PACKS, PLANS, PAID_PLANS } from '../billing/plans.js';
import { cancelSubscription, configured, packAvailable, subscriptionAvailable, webhookSecret } from '../billing/providers.js';
import { verifyRazorpay, verifyStripe } from '../billing/signatures.js';
import { BillingError, checkout, handleWebhook, referralCode, REFERRAL_VOICE_CREDITS, useReferral } from '../billing/service.js';
import { consumeQuota } from '../services/quotas.js';
import { operationalEvent } from '../services/monitoring.js';

const router = Router();
const userId = (req: Request) => (req as unknown as AuthRequest).userId;
const fail = (res: Response, err: unknown, next: NextFunction) => (err instanceof BillingError ? res.status(err.status).json({ error: err.message }) : next(err));
const origin = () => process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';

// Provider webhooks: the raw body is needed for the signature, so this router is mounted before the JSON
// parser (app.ts). Unsigned or wrongly signed requests are refused without being read further.
export const webhooks = Router();
webhooks.post('/:provider', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
  const provider = req.params.provider as Provider;
  if (!PROVIDERS.includes(provider) || !configured(provider)) { res.status(404).end(); return; }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const secret = webhookSecret(provider)!;
  const ok = provider === 'razorpay' ? verifyRazorpay(raw, req.header('x-razorpay-signature'), secret) : verifyStripe(raw, req.header('stripe-signature'), secret);
  if (!ok) { res.status(400).json({ error: 'Invalid signature.' }); return; }
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw.toString('utf8')); } catch { res.status(400).json({ error: 'Invalid body.' }); return; }
  const eventId = provider === 'razorpay' ? req.header('x-razorpay-event-id') : typeof body.id === 'string' ? body.id : undefined;
  if (!eventId || eventId.length > 120) { res.status(400).json({ error: 'Missing event ID.' }); return; }
  try {
    const result = await handleWebhook(provider, eventId, raw, body);
    res.json({ received: true, duplicate: result.duplicate });
  } catch {
    operationalEvent('billing_webhook_failure', 'ERROR');
    res.status(500).json({ error: 'Could not apply the event; it will be retried.' });
  }
});

router.use(requireAuth);

// Plans, prices and which ways of paying are switched on.
router.get('/plans', (_req, res) => {
  res.json({
    plans: [PLANS.free, ...PAID_PLANS.map(id => PLANS[id])].map(p => ({ id: p.id, name: p.name, summary: p.summary, prices: p.prices, entitlements: p.entitlements,
      buy: Object.fromEntries(PROVIDERS.map(pr => [pr, { month: p.id !== 'free' && subscriptionAvailable(pr, p.id as 'pro', 'month'), year: p.id !== 'free' && subscriptionAvailable(pr, p.id as 'pro', 'year') }])) })),
    packs: Object.values(PACKS).map(p => ({ ...p, buy: Object.fromEntries(PROVIDERS.map(pr => [pr, packAvailable(pr, p.id)])) })),
    campus: { tiers: CAMPUS_TIERS, voicePerYear: CAMPUS_VOICE_PER_YEAR, gstExtra: true },
    providers: Object.fromEntries(PROVIDERS.map(p => [p, configured(p)])),
    referralCredits: REFERRAL_VOICE_CREDITS,
  });
});

// The caller's plan, this month's use, credits, subscription, payments, invoices and referral code.
router.get('/me', async (req, res, next) => {
  try {
    const id = new mongoose.Types.ObjectId(userId(req));
    const [u, subscription, payments, invoices, credits, code, referral, referred] = await Promise.all([
      usage(userId(req)), Subscription.findOne({ userId: id }).sort({ createdAt: -1 }).lean(),
      Payment.find({ userId: id }).sort({ capturedAt: -1 }).limit(50).lean(), Invoice.find({ 'recipient.userId': id }).sort({ issuedAt: -1 }).limit(50).select('number issuedAt totals').lean(),
      Credit.find({ userId: id }).sort({ createdAt: -1 }).limit(20).lean(), referralCode(userId(req)), Referral.findOne({ refereeId: id }).lean(),
      Referral.countDocuments({ referrerId: id, status: 'rewarded' }),
    ]);
    res.json({ usage: u,
      subscription: subscription && { plan: subscription.plan, interval: subscription.interval, provider: subscription.provider, status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd, cancelAtPeriodEnd: subscription.cancelAtPeriodEnd },
      payments: payments.map(p => ({ id: String(p._id), kind: p.kind, plan: p.plan, packId: p.packId, amount: p.amount, currency: p.currency, status: p.status, refunded: p.refunded, capturedAt: p.capturedAt, invoiceId: p.invoiceId ? String(p.invoiceId) : null })),
      invoices: invoices.map(i => ({ id: String(i._id), number: i.number, issuedAt: i.issuedAt, total: i.totals.total })),
      credits: credits.map(c => ({ voiceInterviews: c.voiceInterviews, reason: c.reason, createdAt: c.createdAt, expiresAt: c.expiresAt })),
      referral: { code, usedCode: !!referral, rewarded: referred } });
  } catch (err) { next(err); }
});

const checkoutSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('subscription'), provider: z.enum(PROVIDERS), plan: z.enum(PAID_PLANS), interval: z.enum(['month', 'year']), coupon: z.string().trim().max(20).optional() }),
  z.object({ kind: z.literal('pack'), provider: z.enum(PROVIDERS), packId: z.enum(Object.keys(PACKS) as [keyof typeof PACKS]), coupon: z.string().trim().max(20).optional() }),
]);
router.post('/checkout', async (req, res, next) => {
  try {
    const body = checkoutSchema.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'Choose a plan or pack and a way to pay.' }); return; }
    await consumeQuota(userId(req), 'checkouts', 20, 86_400_000);
    res.status(201).json(await checkout(userId(req), { ...body.data, ...(body.data.coupon ? {} : { coupon: undefined }), returnUrl: `${origin()}/billing?returned=1` }));
  } catch (err) { fail(res, err, next); }
});

// Cancels at the end of the paid period; access continues until then.
router.post('/subscription/cancel', async (req, res, next) => {
  try {
    const sub = await Subscription.findOne({ userId: new mongoose.Types.ObjectId(userId(req)), status: { $in: ['active', 'past_due'] } });
    if (!sub) { res.status(404).json({ error: 'You have no active subscription.' }); return; }
    if (!configured(sub.provider)) { res.status(503).json({ error: 'Payments are not enabled; contact support to cancel.' }); return; }
    await cancelSubscription(sub.provider, sub.providerSubscriptionId);
    await Subscription.updateOne({ _id: sub._id }, { $set: { cancelAtPeriodEnd: true } });
    res.json({ cancelAtPeriodEnd: true, currentPeriodEnd: sub.currentPeriodEnd });
  } catch (err) { fail(res, err, next); }
});

router.post('/referral', async (req, res, next) => {
  try {
    const code = z.string().trim().min(6).max(12).safeParse(req.body?.code);
    if (!code.success) { res.status(400).json({ error: 'Enter a referral code.' }); return; }
    await consumeQuota(userId(req), 'referral attempts', 10, 86_400_000);
    await useReferral(userId(req), code.data);
    res.status(201).json({ saved: true, reward: REFERRAL_VOICE_CREDITS });
  } catch (err) { fail(res, err, next); }
});

// A printable GST invoice; only its recipient (or an admin of the organisation it was issued to) can open it.
router.get('/invoices/:id', async (req, res, next) => {
  try {
    const invoice = mongoose.isValidObjectId(req.params.id) ? await Invoice.findOne({ _id: req.params.id, 'recipient.userId': new mongoose.Types.ObjectId(userId(req)) }).lean() : null;
    if (!invoice) { res.status(404).json({ error: 'Invoice not found.' }); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(invoiceHtml(invoice));
  } catch (err) { next(err); }
});

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const inr = (paise: number) => (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function invoiceHtml(i: IInvoice) {
  const intra = !i.placeOfSupply.interState;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tax invoice ${esc(i.number)}</title><style>
body{font:14px/1.5 system-ui,sans-serif;color:#111;max-width:780px;margin:32px auto;padding:0 16px}h1{font-size:20px}table{width:100%;border-collapse:collapse;margin:16px 0}
th,td{border:1px solid #bbb;padding:6px 8px;text-align:left}td.n,th.n{text-align:right}.meta{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap}@media print{body{margin:0}}
</style></head><body><h1>Tax invoice</h1><div class="meta"><div><b>${esc(i.supplier.name)}</b><br>${esc(i.supplier.address)}<br>GSTIN ${esc(i.supplier.gstin)}</div>
<div>Invoice ${esc(i.number)}<br>Date ${esc(new Date(i.issuedAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }))}<br>Place of supply: ${esc(i.placeOfSupply.name)} (${esc(i.placeOfSupply.code)})</div></div>
<p><b>Bill to:</b> ${esc(i.recipient.name)}${i.recipient.address ? `<br>${esc(i.recipient.address)}` : ''}${i.recipient.gstin ? `<br>GSTIN ${esc(i.recipient.gstin)}` : ''}</p>
<table><thead><tr><th>Description</th><th>SAC</th><th class="n">Qty</th><th class="n">Taxable value (₹)</th>${intra ? '<th class="n">CGST (₹)</th><th class="n">SGST (₹)</th>' : '<th class="n">IGST (₹)</th>'}<th class="n">Total (₹)</th></tr></thead><tbody>
${i.lines.map(l => `<tr><td>${esc(l.description)}</td><td>${esc(l.sac)}</td><td class="n">${l.quantity}</td><td class="n">${inr(l.taxable)}</td>${intra ? `<td class="n">${inr(l.cgst)}</td><td class="n">${inr(l.sgst)}</td>` : `<td class="n">${inr(l.igst)}</td>`}<td class="n">${inr(l.total)}</td></tr>`).join('')}
</tbody><tfoot><tr><th colspan="3">Total</th><th class="n">${inr(i.totals.taxable)}</th>${intra ? `<th class="n">${inr(i.totals.cgst)}</th><th class="n">${inr(i.totals.sgst)}</th>` : `<th class="n">${inr(i.totals.igst)}</th>`}<th class="n">${inr(i.totals.total)}</th></tr></tfoot></table>
<p>GST rate ${intra ? 'CGST 9% + SGST 9%' : 'IGST 18%'}. Tax is not payable on reverse charge. This is a computer-generated invoice.</p></body></html>`;
}

export default router;
