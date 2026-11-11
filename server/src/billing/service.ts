import { createHash, randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { BillingEvent, CheckoutIntent, Coupon, CouponRedemption, Credit, Invoice, InvoiceCounter, Payment, Referral, ReferralCode, Subscription,
  type ICheckoutIntent, type Provider } from '../models/Billing.js';
import { User } from '../models/User.js';
import { PACKS, PLANS, rupees, type Interval, type PackId } from './plans.js';
import { configured, packAvailable, startCheckout, subscriptionAvailable } from './providers.js';
import { financialYear, invoiceNumber, placeOfSupply, supplier, taxLine } from './gst.js';

type Id = mongoose.Types.ObjectId;
const oid = (id: string | Id) => new mongoose.Types.ObjectId(String(id));
const DAY = 86_400_000;
export const REFERRAL_VOICE_CREDITS = 3;
export const REFERRAL_WINDOW_DAYS = 30;
export const REFERRAL_REWARDS_PER_MONTH = 10;
export class BillingError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

// ---------------------------------------------------------------- coupons

export async function checkCoupon(code: string, userId: string, target: { kind: 'subscription'; plan: string; interval: Interval } | { kind: 'pack'; amount: number }, now = new Date()) {
  const coupon = await Coupon.findOne({ code: code.trim().toUpperCase(), active: true }).lean();
  if (!coupon || (coupon.expiresAt && coupon.expiresAt <= now) || coupon.redeemed >= coupon.maxRedemptions) throw new BillingError('That code is not valid.');
  if (await CouponRedemption.exists({ code: coupon.code, userId: oid(userId) })) throw new BillingError('You have already used that code.');
  if (target.kind === 'subscription') {
    if (!coupon.plans.includes(target.plan) || !coupon.intervals.includes(target.interval)) throw new BillingError('That code does not apply to this plan.');
    return { coupon, discount: 0 };
  }
  const discount = Math.min(target.amount - 100, coupon.percentOff ? Math.round(target.amount * coupon.percentOff / 100) : coupon.amountOff ?? 0);
  return { coupon, discount: Math.max(0, discount) };
}
async function redeemCoupon(intent: ICheckoutIntent & { _id: Id }) {
  if (!intent.couponCode) return;
  try { await CouponRedemption.create({ code: intent.couponCode, userId: intent.userId, intentId: intent._id }); } catch (err) { if ((err as { code?: number }).code === 11000) return; throw err; }
  await Coupon.updateOne({ code: intent.couponCode }, { $inc: { redeemed: 1 } });
}

// ---------------------------------------------------------------- checkout

export async function checkout(userId: string, input: { provider: Provider; kind: 'subscription'; plan: 'pro' | 'pro_plus'; interval: Interval; coupon?: string; returnUrl: string }
  | { provider: Provider; kind: 'pack'; packId: PackId; coupon?: string; returnUrl: string }) {
  if (!configured(input.provider)) throw new BillingError('Payments are not enabled yet.', 503);
  const user = await User.findById(userId).select('name email').lean();
  if (!user) throw new BillingError('Account not found.', 404);
  const currency = input.provider === 'razorpay' ? 'INR' as const : 'USD' as const;
  if (input.kind === 'subscription') {
    if (!subscriptionAvailable(input.provider, input.plan, input.interval)) throw new BillingError('That plan cannot be bought this way yet.', 503);
    if (await Subscription.exists({ userId: oid(userId), status: { $in: ['active', 'past_due'] } })) throw new BillingError('You already have a subscription. Cancel it before choosing another plan.', 409);
    const coupon = input.coupon ? await checkCoupon(input.coupon, userId, { kind: 'subscription', plan: input.plan, interval: input.interval }) : null;
    const offer = coupon?.coupon.providerOffers?.[input.provider];
    if (coupon && !offer) throw new BillingError('That code cannot be used for subscriptions yet.');
    const amount = PLANS[input.plan].prices[input.interval] ?? 0;
    const intent = await CheckoutIntent.create({ userId: oid(userId), provider: input.provider, kind: 'subscription', plan: input.plan, interval: input.interval, amount, currency,
      ...(coupon ? { couponCode: coupon.coupon.code } : {}) });
    const { ref, url } = await startCheckout(input.provider, { intentId: String(intent._id), userId, email: user.email, name: user.name, returnUrl: input.returnUrl, kind: 'subscription', plan: input.plan, interval: input.interval, offer });
    await CheckoutIntent.updateOne({ _id: intent._id }, { $set: { providerRef: ref, url } });
    return { url };
  }
  const pack = PACKS[input.packId];
  if (!pack || !packAvailable(input.provider, input.packId)) throw new BillingError('That pack cannot be bought this way yet.', 503);
  const coupon = input.coupon ? await checkCoupon(input.coupon, userId, { kind: 'pack', amount: pack.price }) : null;
  const amount = pack.price - (coupon?.discount ?? 0);
  const intent = await CheckoutIntent.create({ userId: oid(userId), provider: input.provider, kind: 'pack', packId: pack.id, amount, currency,
    discount: coupon?.discount ?? 0, ...(coupon ? { couponCode: coupon.coupon.code } : {}) });
  const { ref, url } = await startCheckout(input.provider, { intentId: String(intent._id), userId, email: user.email, name: user.name, returnUrl: input.returnUrl,
    kind: 'pack', packId: pack.id, amount, description: `Interview IQ: ${pack.name}` });
  await CheckoutIntent.updateOne({ _id: intent._id }, { $set: { providerRef: ref, url } });
  return { url };
}

// ---------------------------------------------------------------- webhooks

// What a provider event means for us, independent of the provider.
export type BillingChange =
  | { type: 'pack_paid'; intentId?: string; ref?: string; paymentId: string; amount: number; currency: 'INR' | 'USD' }
  | { type: 'subscription_active'; intentId?: string; subscriptionId: string; periodEnd?: Date; payment?: { id: string; amount: number; currency: 'INR' | 'USD' } }
  | { type: 'subscription_status'; subscriptionId: string; status: 'past_due' | 'cancelled' | 'expired'; periodEnd?: Date }
  | { type: 'refund'; paymentId: string; refunded: number }
  | { type: 'ignored' };

const unix = (v: unknown) => (typeof v === 'number' && v > 0 ? new Date(v * 1000) : undefined);
const cur = (v: unknown) => (String(v).toUpperCase() === 'USD' ? 'USD' as const : 'INR' as const);
type Obj = Record<string, any>;
export function normaliseRazorpay(body: Obj): BillingChange {
  const p = body.payload ?? {};
  const sub = p.subscription?.entity, pay = p.payment?.entity, link = p.payment_link?.entity, refund = p.refund?.entity;
  switch (body.event) {
    case 'payment_link.paid': return { type: 'pack_paid', intentId: link?.notes?.intentId ?? link?.reference_id, ref: link?.id, paymentId: pay?.id, amount: pay?.amount, currency: cur(pay?.currency) };
    case 'subscription.activated': case 'subscription.charged': case 'subscription.resumed':
      return { type: 'subscription_active', intentId: sub?.notes?.intentId, subscriptionId: sub?.id, periodEnd: unix(sub?.current_end),
        ...(body.event === 'subscription.charged' && pay ? { payment: { id: pay.id, amount: pay.amount, currency: cur(pay.currency) } } : {}) };
    case 'subscription.halted': case 'subscription.pending': return { type: 'subscription_status', subscriptionId: sub?.id, status: 'past_due' };
    case 'subscription.cancelled': return { type: 'subscription_status', subscriptionId: sub?.id, status: 'cancelled', periodEnd: unix(sub?.current_end) };
    case 'subscription.completed': return { type: 'subscription_status', subscriptionId: sub?.id, status: 'expired', periodEnd: unix(sub?.current_end) };
    case 'refund.processed': return { type: 'refund', paymentId: refund?.payment_id, refunded: refund?.amount };
    default: return { type: 'ignored' };
  }
}
export function normaliseStripe(body: Obj): BillingChange {
  const o = body.data?.object ?? {};
  switch (body.type) {
    case 'checkout.session.completed':
      if (o.payment_status !== 'paid') return { type: 'ignored' };
      return o.mode === 'payment' ? { type: 'pack_paid', intentId: o.metadata?.intentId ?? o.client_reference_id, ref: o.id, paymentId: o.payment_intent ?? o.id, amount: o.amount_total, currency: cur(o.currency) }
        : { type: 'subscription_active', intentId: o.metadata?.intentId ?? o.client_reference_id, subscriptionId: o.subscription };
    case 'invoice.paid': return o.subscription || o.parent?.subscription_details?.subscription ? { type: 'subscription_active',
      intentId: o.subscription_details?.metadata?.intentId ?? o.parent?.subscription_details?.metadata?.intentId, subscriptionId: o.subscription ?? o.parent.subscription_details.subscription,
      periodEnd: unix(o.lines?.data?.[0]?.period?.end), payment: { id: o.payment_intent ?? o.id, amount: o.amount_paid, currency: cur(o.currency) } } : { type: 'ignored' };
    case 'customer.subscription.updated': {
      const periodEnd = unix(o.current_period_end ?? o.items?.data?.[0]?.current_period_end);
      if (o.status === 'active' || o.status === 'trialing') return o.cancel_at_period_end ? { type: 'subscription_status', subscriptionId: o.id, status: 'cancelled', periodEnd }
        : { type: 'subscription_active', intentId: o.metadata?.intentId, subscriptionId: o.id, periodEnd };
      return ['past_due', 'unpaid', 'incomplete'].includes(o.status) ? { type: 'subscription_status', subscriptionId: o.id, status: 'past_due' } : { type: 'ignored' };
    }
    case 'customer.subscription.deleted': return { type: 'subscription_status', subscriptionId: o.id, status: 'expired', periodEnd: new Date(body.created ? body.created * 1000 : Date.now()) };
    case 'charge.refunded': return { type: 'refund', paymentId: o.payment_intent ?? o.id, refunded: o.amount_refunded };
    default: return { type: 'ignored' };
  }
}

async function intentFor(provider: Provider, change: { intentId?: string; ref?: string }) {
  if (change.intentId && mongoose.isValidObjectId(change.intentId)) { const i = await CheckoutIntent.findOne({ _id: change.intentId, provider }); if (i) return i; }
  return change.ref ? CheckoutIntent.findOne({ provider, providerRef: change.ref }) : null;
}
async function recordPayment(fields: { userId: Id; provider: Provider; providerPaymentId: string; kind: 'subscription' | 'pack'; amount: number; currency: 'INR' | 'USD'; plan?: string; packId?: string; subscriptionId?: Id }) {
  try { return { payment: await Payment.create({ ...fields, capturedAt: new Date() }), created: true }; }
  catch (err) { if ((err as { code?: number }).code !== 11000) throw err; return { payment: (await Payment.findOne({ provider: fields.provider, providerPaymentId: fields.providerPaymentId }))!, created: false }; }
}
async function credit(userId: Id, voiceInterviews: number, reason: 'pack' | 'referral' | 'refund', ref: string) {
  try { await Credit.create({ userId, voiceInterviews, reason, ref, ...(voiceInterviews > 0 ? { expiresAt: new Date(Date.now() + 365 * DAY) } : {}) }); }
  catch (err) { if ((err as { code?: number }).code !== 11000) throw err; }
}

export async function applyChange(provider: Provider, change: BillingChange): Promise<'applied' | 'ignored'> {
  if (change.type === 'ignored') return 'ignored';
  if (change.type === 'pack_paid') {
    const intent = await intentFor(provider, change);
    if (!intent || intent.kind !== 'pack' || !intent.packId || !change.paymentId) throw new Error('No checkout matches this payment.');
    const { payment, created } = await recordPayment({ userId: intent.userId, provider, providerPaymentId: change.paymentId, kind: 'pack', amount: change.amount, currency: change.currency, packId: intent.packId });
    await credit(intent.userId, PACKS[intent.packId].voiceInterviews, 'pack', `pack:${provider}:${change.paymentId}`);
    await CheckoutIntent.updateOne({ _id: intent._id }, { $set: { status: 'paid' } });
    await redeemCoupon(intent);
    if (created) await afterPayment(payment._id);
    return 'applied';
  }
  if (change.type === 'subscription_active') {
    let sub = await Subscription.findOne({ provider, providerSubscriptionId: change.subscriptionId });
    if (!sub) {
      const intent = await intentFor(provider, { intentId: change.intentId, ref: change.subscriptionId });
      if (!intent || intent.kind !== 'subscription' || !intent.plan || !intent.interval) throw new Error('No checkout matches this subscription.');
      try {
        sub = await Subscription.create({ userId: intent.userId, plan: intent.plan, interval: intent.interval, provider, providerSubscriptionId: change.subscriptionId, status: 'active',
          ...(intent.couponCode ? { couponCode: intent.couponCode } : {}) });
      } catch (err) { if ((err as { code?: number }).code !== 11000) throw err; sub = (await Subscription.findOne({ provider, providerSubscriptionId: change.subscriptionId }))!; }
      await CheckoutIntent.updateOne({ _id: intent._id }, { $set: { status: 'paid' } });
      await redeemCoupon(intent);
    }
    // Periods only move forward, whatever order the events arrive in.
    const end = change.periodEnd && (!sub.currentPeriodEnd || change.periodEnd > sub.currentPeriodEnd) ? change.periodEnd : sub.currentPeriodEnd;
    await Subscription.updateOne({ _id: sub._id, status: { $ne: 'expired' } }, { $set: { status: 'active', cancelAtPeriodEnd: false, ...(end ? { currentPeriodEnd: end } : {}) } });
    if (change.payment?.id) {
      const { payment, created } = await recordPayment({ userId: sub.userId, provider, providerPaymentId: change.payment.id, kind: 'subscription', amount: change.payment.amount,
        currency: change.payment.currency, plan: sub.plan, subscriptionId: sub._id });
      if (created) await afterPayment(payment._id);
    }
    return 'applied';
  }
  if (change.type === 'subscription_status') {
    const sub = await Subscription.findOne({ provider, providerSubscriptionId: change.subscriptionId });
    if (!sub) return 'ignored';
    const end = change.status === 'expired' ? (change.periodEnd && sub.currentPeriodEnd && change.periodEnd < sub.currentPeriodEnd ? change.periodEnd : sub.currentPeriodEnd ?? change.periodEnd)
      : change.periodEnd ?? sub.currentPeriodEnd;
    await Subscription.updateOne({ _id: sub._id }, { $set: { status: change.status, cancelAtPeriodEnd: change.status === 'cancelled', ...(end ? { currentPeriodEnd: end } : {}) } });
    return 'applied';
  }
  const payment = await Payment.findOne({ provider, providerPaymentId: change.paymentId });
  if (!payment) throw new Error('No payment matches this refund.');
  const refunded = Math.min(payment.amount, Math.max(payment.refunded, change.refunded));
  await Payment.updateOne({ _id: payment._id }, { $set: { refunded, status: refunded >= payment.amount ? 'refunded' : 'partially_refunded' } });
  if (refunded >= payment.amount && payment.kind === 'pack' && payment.packId && payment.userId) {
    await credit(payment.userId, -PACKS[payment.packId as PackId].voiceInterviews, 'refund', `refund:${provider}:${payment.providerPaymentId}`);
  }
  return 'applied';
}

// Every event is recorded once by (provider, event ID). A repeated event is acknowledged without being
// applied again; a failed one can be retried by the provider.
export async function handleWebhook(provider: Provider, eventId: string, raw: Buffer, body: Obj) {
  const type = String(provider === 'razorpay' ? body.event : body.type).slice(0, 80);
  const payloadSha256 = createHash('sha256').update(raw).digest('hex');
  const existing = await BillingEvent.findOneAndUpdate({ provider, eventId }, { $setOnInsert: { type, payloadSha256, outcome: 'processing', receivedAt: new Date() } }, { upsert: true, new: false });
  if (existing && existing.outcome !== 'failed') return { duplicate: true, outcome: existing.outcome };
  if (existing) await BillingEvent.updateOne({ _id: existing._id, outcome: 'failed' }, { $set: { outcome: 'processing' } });
  try {
    const outcome = await applyChange(provider, provider === 'razorpay' ? normaliseRazorpay(body) : normaliseStripe(body));
    await BillingEvent.updateOne({ provider, eventId }, { $set: { outcome }, $unset: { detail: 1 } });
    return { duplicate: false, outcome };
  } catch (err) {
    await BillingEvent.updateOne({ provider, eventId }, { $set: { outcome: 'failed', detail: (err as Error).message.slice(0, 200) } });
    throw err;
  }
}

// ---------------------------------------------------------------- after a payment: referral reward and invoice

async function afterPayment(paymentId: Id) {
  const payment = await Payment.findById(paymentId).lean();
  if (!payment?.userId) return;
  if (await Payment.countDocuments({ userId: payment.userId }) === 1) await rewardReferral(payment.userId);
  if (payment.currency === 'INR') await issueInvoice(paymentId).catch(() => undefined);
}
async function rewardReferral(refereeId: Id) {
  const referral = await Referral.findOneAndUpdate({ refereeId, status: 'pending' }, { $set: { status: 'rewarded', rewardedAt: new Date() } }, { new: true });
  if (!referral) return;
  await credit(refereeId, REFERRAL_VOICE_CREDITS, 'referral', `referral:${referral._id}:referee`);
  const since = new Date(Date.now() - 30 * DAY);
  if (await Referral.countDocuments({ referrerId: referral.referrerId, status: 'rewarded', rewardedAt: { $gte: since } }) <= REFERRAL_REWARDS_PER_MONTH) {
    await credit(referral.referrerId, REFERRAL_VOICE_CREDITS, 'referral', `referral:${referral._id}:referrer`);
  }
}

const CODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export async function referralCode(userId: string) {
  const existing = await ReferralCode.findOne({ userId: oid(userId) }).lean();
  if (existing) return existing.code as string;
  for (let i = 0; i < 5; i++) {
    const code = [...randomBytes(8)].map(b => CODE[b % CODE.length]).join('');
    try { await ReferralCode.create({ userId: oid(userId), code }); return code; }
    catch (err) { if ((err as { code?: number }).code !== 11000) throw err; const again = await ReferralCode.findOne({ userId: oid(userId) }).lean(); if (again) return again.code as string; }
  }
  throw new Error('Could not create a referral code.');
}
export async function useReferral(userId: string, code: string, now = new Date()) {
  const user = await User.findById(userId).select('createdAt').lean();
  if (!user || now.getTime() - new Date(user.createdAt as unknown as string).getTime() > REFERRAL_WINDOW_DAYS * DAY) throw new BillingError(`Referral codes can be entered within ${REFERRAL_WINDOW_DAYS} days of joining.`);
  if (await Payment.exists({ userId: oid(userId) })) throw new BillingError('Referral codes are for new members who have not paid yet.');
  const owner = await ReferralCode.findOne({ code: code.trim().toUpperCase() }).lean();
  if (!owner) throw new BillingError('That referral code is not valid.');
  if (String(owner.userId) === String(userId)) throw new BillingError('You cannot use your own referral code.');
  try { await Referral.create({ referrerId: owner.userId, refereeId: oid(userId) }); }
  catch (err) { if ((err as { code?: number }).code === 11000) throw new BillingError('You have already used a referral code.', 409); throw err; }
}

// A GST invoice for a captured INR payment. Consumer prices include GST. Without the supplier's GST details
// configured, no invoice is issued (reconciliation lists such payments).
export async function issueInvoice(paymentId: Id, recipientOverride?: { name: string; address?: string; gstin?: string; stateCode?: string }) {
  const s = supplier();
  if (!s) throw new BillingError('Invoicing is not configured.', 503);
  const existing = await Invoice.findOne({ paymentId }).lean();
  if (existing) return existing;
  const payment = await Payment.findById(paymentId).lean();
  if (!payment || payment.currency !== 'INR') throw new BillingError('Only INR payments are invoiced automatically.');
  const user = payment.userId ? await User.findById(payment.userId).select('name').lean() : null;
  const recipient = recipientOverride ?? { name: user?.name ?? 'Customer' };
  const place = placeOfSupply(s.stateCode, recipient);
  const description = payment.kind === 'pack' ? `Interview IQ ${PACKS[payment.packId as PackId]?.name ?? 'pack'}` : `Interview IQ ${PLANS[payment.plan as 'pro' | 'pro_plus']?.name ?? ''} subscription`;
  const line = taxLine({ description, sac: s.sac, quantity: 1, unitPrice: payment.amount, inclusive: payment.kind !== 'campus' }, place.interState, s.ratePercent);
  return createInvoice({ supplier: s, recipient: { ...recipient, ...(payment.userId ? { userId: payment.userId } : {}), ...(payment.orgId ? { orgId: payment.orgId } : {}) }, place, lines: [line], paymentId });
}
export async function createInvoice(input: { supplier: NonNullable<ReturnType<typeof supplier>>; recipient: Record<string, unknown>; place: ReturnType<typeof placeOfSupply>; lines: ReturnType<typeof taxLine>[]; paymentId?: Id; issuedAt?: Date }) {
  const issuedAt = input.issuedAt ?? new Date();
  const fy = financialYear(issuedAt);
  const counter = await InvoiceCounter.findOneAndUpdate({ _id: fy.short }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  const totals = input.lines.reduce((t, l) => ({ taxable: t.taxable + l.taxable, cgst: t.cgst + l.cgst, sgst: t.sgst + l.sgst, igst: t.igst + l.igst, total: t.total + l.total }), { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 });
  const { name, address, gstin, stateCode } = input.supplier;
  const invoice = await Invoice.create({ number: invoiceNumber(input.supplier.prefix, issuedAt, counter.seq), financialYear: fy.label, sequence: counter.seq, issuedAt,
    supplier: { name, address, gstin, stateCode }, recipient: input.recipient, placeOfSupply: input.place, lines: input.lines, totals, ...(input.paymentId ? { paymentId: input.paymentId } : {}) });
  if (input.paymentId) await Payment.updateOne({ _id: input.paymentId }, { $set: { invoiceId: invoice._id } });
  return invoice.toObject();
}

export const describeAmount = rupees;
