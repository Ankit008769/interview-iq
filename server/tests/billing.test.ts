import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { financialYear, gstinCheckChar, invoiceNumber, placeOfSupply, taxLine, validGstin } from '../src/billing/gst.js';
import { signRazorpay, signStripe, verifyRazorpay, verifyRazorpayPayment, verifyStripe } from '../src/billing/signatures.js';
import { campusPrice, PACKS, PLANS } from '../src/billing/plans.js';
import { claimVoiceInterview, currentPlan, monthStart, requireCapability, requireInterviewAllowance, usage, EntitlementError } from '../src/billing/entitlements.js';
import { BillingEvent, CampusLicence, CheckoutIntent, Coupon, CouponRedemption, Credit, Invoice, Payment, Referral, Subscription } from '../src/models/Billing.js';
import { Membership, SHARING_VERSION } from '../src/models/Organization.js';
import { Interview } from '../src/models/Interview.js';
import { User } from '../src/models/User.js';
import { checkCoupon, handleWebhook, normaliseRazorpay, normaliseStripe, referralCode, useReferral, REFERRAL_VOICE_CREDITS } from '../src/billing/service.js';
import { readProviderCsv, reconcile, revenueMetrics, analyticsRows } from '../src/billing/reports.js';
import { csvCell, csvRecords } from '../src/services/csv.js';

const DAY = 86_400_000;
// A syntactically valid GSTIN for Karnataka (29) with the right check character.
const gstin = (state: string, pan = 'AAACI1234F') => { const first = `${state}${pan}1Z`; return first + gstinCheckChar(first); };

describe('GST', () => {
  it('validates GSTINs with their check character', () => {
    const g = gstin('29');
    expect(validGstin(g)).toBe(true);
    expect(validGstin(g.toLowerCase())).toBe(true);
    expect(validGstin(g.slice(0, 14) + (g[14] === 'A' ? 'B' : 'A'))).toBe(false);
    expect(validGstin('99AAACI1234F1Z5')).toBe(false); // unknown state
    expect(validGstin('29AAACI1234F1X5')).toBe(false);
    // A published example GSTIN (Maharashtra) checks out.
    expect(validGstin('27AAPFU0939F1ZV')).toBe(true);
  });
  it('splits tax by place of supply and keeps consumer prices GST-inclusive', () => {
    const consumer = taxLine({ description: 'Pro', sac: '999293', quantity: 1, unitPrice: 29_900, inclusive: true }, false);
    expect(consumer).toMatchObject({ taxable: 25_339, cgst: 2_280, sgst: 2_281, igst: 0, total: 29_900 });
    const campus = taxLine({ description: 'Campus licence', sac: '999293', quantity: 300, unitPrice: 75_000, inclusive: false }, true);
    expect(campus).toMatchObject({ taxable: 2_25_00_000, igst: 40_50_000, cgst: 0, sgst: 0, total: 2_65_50_000 });
    expect(placeOfSupply('29', { gstin: gstin('27') })).toEqual({ code: '27', name: 'Maharashtra', interState: true });
    expect(placeOfSupply('29', {})).toEqual({ code: '29', name: 'Karnataka', interState: false });
    expect(placeOfSupply('29', { stateCode: '33' }).interState).toBe(true);
    expect(() => taxLine({ description: 'x', sac: '1', quantity: 0, unitPrice: 1, inclusive: true }, false)).toThrow();
  });
  it('numbers invoices per Indian financial year within 16 characters', () => {
    // Midnight on 1 April in India is 18:30 UTC on 31 March.
    expect(financialYear(new Date('2027-03-31T18:30:00Z'))).toEqual({ start: 2027, label: '2027-28', short: '2728' });
    expect(financialYear(new Date('2027-03-31T18:29:00Z')).label).toBe('2026-27');
    expect(invoiceNumber('IQ', new Date('2026-11-11T00:00:00Z'), 42)).toBe('IQ/2627/000042');
    expect(() => invoiceNumber('TOOLONG', new Date(), 1)).toThrow();
  });
});

describe('webhook signatures', () => {
  const raw = '{"event":"payment_link.paid"}';
  it('accepts only an exact Razorpay HMAC', () => {
    const sig = signRazorpay(raw, 'whsec');
    expect(verifyRazorpay(Buffer.from(raw), sig, 'whsec')).toBe(true);
    expect(verifyRazorpay(Buffer.from(raw + ' '), sig, 'whsec')).toBe(false);
    expect(verifyRazorpay(Buffer.from(raw), sig, 'other')).toBe(false);
    expect(verifyRazorpay(Buffer.from(raw), undefined, 'whsec')).toBe(false);
    expect(verifyRazorpay(Buffer.from(raw), sig.toUpperCase(), 'whsec')).toBe(false);
    expect(verifyRazorpayPayment(['order_1', 'pay_1'], signRazorpay('order_1|pay_1', 'key'), 'key')).toBe(true);
  });
  it('accepts a fresh Stripe signature and refuses stale or altered ones', () => {
    const now = Date.now(); const t = Math.floor(now / 1000);
    const header = signStripe(raw, 'whsec', t);
    expect(verifyStripe(Buffer.from(raw), header, 'whsec', now)).toBe(true);
    expect(verifyStripe(Buffer.from(raw), `${header},v1=${'0'.repeat(64)}`, 'whsec', now)).toBe(true);
    expect(verifyStripe(Buffer.from(raw), header, 'whsec', now + 301_000)).toBe(false);
    expect(verifyStripe(Buffer.from('{}'), header, 'whsec', now)).toBe(false);
    expect(verifyStripe(Buffer.from(raw), `t=${t}`, 'whsec', now)).toBe(false);
    expect(verifyStripe(Buffer.from(raw), undefined, 'whsec', now)).toBe(false);
  });
});

describe('plans and CSV', () => {
  it('prices campus licences by volume tier', () => {
    expect(campusPrice(100)).toEqual({ perStudent: 90_000, total: 90_00_000 });
    expect(campusPrice(300).perStudent).toBe(75_000);
    expect(campusPrice(1500).perStudent).toBe(60_000);
    expect(() => campusPrice(0)).toThrow();
    expect(PLANS.pro.prices).toEqual({ month: 29_900, year: 2_49_900 });
  });
  it('parses quoted CSV and neutralises formulas', () => {
    expect(csvRecords('﻿Id,Amount Refunded\r\n"pay_1","1,000.50"\r\n')).toEqual([{ id: 'pay_1', amount_refunded: '1,000.50' }]);
    expect(csvCell('=1+1')).toBe("'=1+1");
  });
});

describe('billing with a database', () => {
  let mongo: MongoMemoryServer;
  let user: mongoose.Types.ObjectId, other: mongoose.Types.ObjectId;
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); }, 120_000);
  beforeEach(async () => {
    await mongoose.connection.db!.dropDatabase();
    await Promise.all([Payment, Subscription, Credit, Invoice, BillingEvent, Coupon, CouponRedemption, Referral].map(m => m.syncIndexes()));
    [user, other] = (await User.insertMany([{ name: 'Asha', email: 'asha@example.test', passwordHash: 'x' }, { name: 'Ravi', email: 'ravi@example.test', passwordHash: 'x' }])).map(u => u._id);
    vi.stubEnv('GST_SUPPLIER_NAME', 'Interview IQ Private Limited'); vi.stubEnv('GST_SUPPLIER_ADDRESS', 'Bengaluru, Karnataka'); vi.stubEnv('GST_SUPPLIER_GSTIN', gstin('29'));
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
  const rzpEvent = (event: string, payload: object) => ({ event, payload });

  it('applies a pack payment once, however often the webhook arrives, and invoices it', async () => {
    const intent = await CheckoutIntent.create({ userId: user, provider: 'razorpay', kind: 'pack', packId: 'voice_5', amount: PACKS.voice_5.price, currency: 'INR', providerRef: 'plink_1' });
    const body = rzpEvent('payment_link.paid', { payment_link: { entity: { id: 'plink_1', notes: { intentId: String(intent._id) } } }, payment: { entity: { id: 'pay_1', amount: 9_900, currency: 'INR' } } });
    const raw = Buffer.from(JSON.stringify(body));
    expect(await handleWebhook('razorpay', 'evt_1', raw, body)).toEqual({ duplicate: false, outcome: 'applied' });
    expect(await handleWebhook('razorpay', 'evt_1', raw, body)).toEqual({ duplicate: true, outcome: 'applied' });
    // The same payment delivered under a new event ID changes nothing either.
    expect((await handleWebhook('razorpay', 'evt_2', raw, body)).outcome).toBe('applied');
    expect(await Payment.countDocuments()).toBe(1);
    expect((await Credit.find({ userId: user }).lean()).map(c => c.voiceInterviews)).toEqual([5]);
    const invoice = await Invoice.findOne().lean();
    expect(invoice).toMatchObject({ number: expect.stringMatching(/^IQ\/\d{4}\/000001$/), totals: { taxable: 8_390, cgst: 755, sgst: 755, igst: 0, total: 9_900 }, recipient: { name: 'Asha' } });
    expect((await Payment.findOne().lean())!.invoiceId).toEqual(invoice!._id);
    expect(await BillingEvent.countDocuments({ outcome: 'applied' })).toBe(2);
  });

  it('keeps a failed event retryable and never invents a user', async () => {
    const body = rzpEvent('payment_link.paid', { payment_link: { entity: { id: 'plink_x', notes: { intentId: String(new mongoose.Types.ObjectId()) } } }, payment: { entity: { id: 'pay_x', amount: 9_900, currency: 'INR' } } });
    const raw = Buffer.from(JSON.stringify(body));
    await expect(handleWebhook('razorpay', 'evt_x', raw, body)).rejects.toThrow(/No checkout/);
    expect((await BillingEvent.findOne({ eventId: 'evt_x' }).lean())!.outcome).toBe('failed');
    await CheckoutIntent.create({ userId: user, provider: 'razorpay', kind: 'pack', packId: 'voice_5', amount: 9_900, currency: 'INR', providerRef: 'plink_x' });
    expect((await handleWebhook('razorpay', 'evt_x', raw, body)).outcome).toBe('applied');
    expect(await Payment.countDocuments({ userId: user })).toBe(1);
  });

  it('runs a subscription through activation, renewal, cancellation and expiry', async () => {
    const intent = await CheckoutIntent.create({ userId: user, provider: 'stripe', kind: 'subscription', plan: 'pro', interval: 'month', amount: 29_900, currency: 'USD', providerRef: 'cs_1' });
    const end1 = Math.floor((Date.now() + 30 * DAY) / 1000), end2 = end1 + 30 * 86_400;
    const ev = (id: string, type: string, object: object) => { const body = { id, type, created: Math.floor(Date.now() / 1000), data: { object } }; return handleWebhook('stripe', id, Buffer.from(JSON.stringify(body)), body); };
    // Stripe may deliver the invoice before the checkout session.
    await ev('evt_inv1', 'invoice.paid', { id: 'in_1', subscription: 'sub_1', subscription_details: { metadata: { intentId: String(intent._id) } }, amount_paid: 400, currency: 'usd', payment_intent: 'pi_1', lines: { data: [{ period: { end: end1 } }] } });
    await ev('evt_cs', 'checkout.session.completed', { id: 'cs_1', mode: 'subscription', payment_status: 'paid', client_reference_id: String(intent._id), subscription: 'sub_1' });
    expect(await currentPlan(String(user))).toMatchObject({ plan: 'pro', source: 'subscription' });
    await ev('evt_inv2', 'invoice.paid', { id: 'in_2', subscription: 'sub_1', amount_paid: 400, currency: 'usd', payment_intent: 'pi_2', lines: { data: [{ period: { end: end2 } }] } });
    // An older update arriving late cannot move the period back.
    await ev('evt_old', 'customer.subscription.updated', { id: 'sub_1', status: 'active', current_period_end: end1 });
    let sub = await Subscription.findOne().lean();
    expect(sub).toMatchObject({ status: 'active', plan: 'pro', interval: 'month' });
    expect(sub!.currentPeriodEnd!.getTime()).toBe(end2 * 1000);
    expect(await Payment.countDocuments({ kind: 'subscription', currency: 'USD' })).toBe(2);
    expect(await Invoice.countDocuments()).toBe(0); // international payments are not invoiced automatically
    await ev('evt_cancel', 'customer.subscription.updated', { id: 'sub_1', status: 'active', cancel_at_period_end: true, current_period_end: end2 });
    sub = await Subscription.findOne().lean();
    expect(sub).toMatchObject({ status: 'cancelled', cancelAtPeriodEnd: true });
    expect((await currentPlan(String(user))).plan).toBe('pro'); // paid time is kept
    await ev('evt_del', 'customer.subscription.deleted', { id: 'sub_1' });
    expect((await currentPlan(String(user))).plan).toBe('free');
    // Normalisers cover both API shapes and ignore unrelated events.
    expect(normaliseStripe({ type: 'customer.subscription.updated', data: { object: { id: 's', status: 'active', items: { data: [{ current_period_end: end1 }] } } } }))
      .toMatchObject({ type: 'subscription_active', periodEnd: new Date(end1 * 1000) });
    expect(normaliseStripe({ type: 'payment_intent.created', data: { object: {} } })).toEqual({ type: 'ignored' });
    expect(normaliseRazorpay({ event: 'subscription.halted', payload: { subscription: { entity: { id: 'sub_r' } } } })).toEqual({ type: 'subscription_status', subscriptionId: 'sub_r', status: 'past_due' });
  });

  it('refunds a pack and takes its credits back', async () => {
    await CheckoutIntent.create({ userId: user, provider: 'razorpay', kind: 'pack', packId: 'voice_15', amount: 24_900, currency: 'INR', providerRef: 'plink_r' });
    const paid = rzpEvent('payment_link.paid', { payment_link: { entity: { id: 'plink_r', notes: {} } }, payment: { entity: { id: 'pay_r', amount: 24_900, currency: 'INR' } } });
    await handleWebhook('razorpay', 'e1', Buffer.from('1'), paid);
    const refund = rzpEvent('refund.processed', { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_r', amount: 24_900 } } });
    await handleWebhook('razorpay', 'e2', Buffer.from('2'), refund);
    expect(await Payment.findOne().lean()).toMatchObject({ status: 'refunded', refunded: 24_900 });
    expect((await usage(String(user))).credits).toBe(0);
  });

  it('applies coupons to packs once per person and only to the plans they name', async () => {
    await Coupon.create({ code: 'LAUNCH20', percentOff: 20, maxRedemptions: 2, plans: ['pro'] });
    expect((await checkCoupon('launch20', String(user), { kind: 'pack', amount: 9_900 })).discount).toBe(1_980);
    await expect(checkCoupon('LAUNCH20', String(user), { kind: 'subscription', plan: 'pro_plus', interval: 'month' })).rejects.toThrow(/does not apply/);
    await expect(checkCoupon('NOPE1234', String(user), { kind: 'pack', amount: 9_900 })).rejects.toThrow(/not valid/);
    await CouponRedemption.create({ code: 'LAUNCH20', userId: user });
    await expect(checkCoupon('LAUNCH20', String(user), { kind: 'pack', amount: 9_900 })).rejects.toThrow(/already used/);
    await Coupon.create({ code: 'BIGOFF', amountOff: 50_000, maxRedemptions: 1 });
    expect((await checkCoupon('BIGOFF', String(other), { kind: 'pack', amount: 9_900 })).discount).toBe(9_800); // at least ₹1 is paid
  });

  it('rewards both sides of a referral on the new member\'s first payment', async () => {
    const code = await referralCode(String(user));
    expect(await referralCode(String(user))).toBe(code);
    await expect(useReferral(String(user), code)).rejects.toThrow(/own referral code/);
    await useReferral(String(other), code);
    await expect(useReferral(String(other), code)).rejects.toThrow(/already used/);
    await CheckoutIntent.create({ userId: other, provider: 'razorpay', kind: 'pack', packId: 'voice_5', amount: 9_900, currency: 'INR', providerRef: 'plink_ref' });
    await handleWebhook('razorpay', 'eref', Buffer.from('x'), rzpEvent('payment_link.paid', { payment_link: { entity: { id: 'plink_ref', notes: {} } }, payment: { entity: { id: 'pay_ref', amount: 9_900, currency: 'INR' } } }));
    expect((await usage(String(user))).credits).toBe(REFERRAL_VOICE_CREDITS);
    expect((await usage(String(other))).credits).toBe(5 + REFERRAL_VOICE_CREDITS);
    expect((await Referral.findOne().lean())!.status).toBe('rewarded');
    // Late or paid members cannot add a code.
    await User.collection.updateOne({ _id: other }, { $set: { createdAt: new Date(Date.now() - 40 * DAY) } });
    await Referral.deleteMany({});
    await expect(useReferral(String(other), code)).rejects.toThrow(/within 30 days/);
  });

  it('enforces plan limits only when switched on, and spends credits after the allowance', async () => {
    const start = (n: number, extra: object = {}) => Interview.collection.insertMany(Array.from({ length: n }, () => ({ userId: user, mode: 'ai', status: 'completed', createdAt: new Date(), ...extra })));
    await start(5);
    await expect(requireInterviewAllowance(String(user))).resolves.toBeUndefined(); // beta: nothing blocked
    await expect(requireCapability(String(user), 'coding_lab')).resolves.toBeUndefined();
    vi.stubEnv('BILLING_ENFORCEMENT', 'on');
    await expect(requireInterviewAllowance(String(user))).rejects.toBeInstanceOf(EntitlementError);
    await expect(requireCapability(String(user), 'coding_lab')).rejects.toMatchObject({ plan: 'pro_plus', capability: 'coding_lab' });
    await expect(requireCapability(String(user), 'resume_jd')).rejects.toMatchObject({ plan: 'pro' });
    // Free: three voice interviews a month, then a credit each.
    await start(3, { voiceUsedAt: new Date() });
    const fresh = (await Interview.collection.insertOne({ userId: user, mode: 'ai', status: 'in_progress', createdAt: new Date() })).insertedId;
    expect(await claimVoiceInterview(String(user), String(fresh))).toBe(false);
    await Credit.create({ userId: user, voiceInterviews: 2, reason: 'adjustment', expiresAt: new Date(Date.now() + DAY) });
    expect(await claimVoiceInterview(String(user), String(fresh))).toBe(true);
    expect(await claimVoiceInterview(String(user), String(fresh))).toBe(true); // the same interview is not charged twice
    expect((await usage(String(user))).credits).toBe(1);
    // Last month's interviews do not count.
    await Interview.collection.updateMany({ userId: user }, { $set: { createdAt: new Date(monthStart().getTime() - DAY), voiceUsedAt: new Date(monthStart().getTime() - DAY) } });
    await expect(requireInterviewAllowance(String(user))).resolves.toBeUndefined();
  });

  it('gives a licensed college\'s earliest students the Campus plan, up to its seats', async () => {
    const orgId = new mongoose.Types.ObjectId();
    await Membership.insertMany([{ orgId, userId: user, role: 'student', sharingVersion: SHARING_VERSION, sharingAcceptedAt: new Date(), createdAt: new Date(Date.now() - 2 * DAY) },
      { orgId, userId: other, role: 'student', sharingVersion: SHARING_VERSION, sharingAcceptedAt: new Date(), createdAt: new Date() }]);
    expect((await currentPlan(String(user))).plan).toBe('free');
    await CampusLicence.create({ orgId, seats: 1, startsAt: new Date(Date.now() - DAY), endsAt: new Date(Date.now() + 300 * DAY), perStudent: 90_000 });
    expect(await currentPlan(String(user))).toMatchObject({ plan: 'campus', orgId: String(orgId) });
    expect((await currentPlan(String(other))).plan).toBe('free');
    expect((await usage(String(user))).entitlements.voiceInterviews).toBe(12);
  });

  it('reconciles provider exports to the paisa and reports revenue metrics', async () => {
    const now = new Date();
    await Payment.insertMany([
      { userId: user, provider: 'razorpay', providerPaymentId: 'pay_a', kind: 'pack', packId: 'voice_5', amount: 9_900, currency: 'INR', capturedAt: now, invoiceId: new mongoose.Types.ObjectId() },
      { userId: other, provider: 'razorpay', providerPaymentId: 'pay_b', kind: 'subscription', plan: 'pro', amount: 29_900, currency: 'INR', capturedAt: now, refunded: 0 },
    ]);
    const exportCsv = 'id,amount,currency,status,amount_refunded\npay_a,99.00,INR,captured,0\npay_b,299.00,INR,captured,0\npay_f,10.00,INR,failed,0\n';
    const from = new Date(now.getTime() - DAY), to = new Date(now.getTime() + DAY);
    const ok = await reconcile('razorpay', readProviderCsv(exportCsv), from, to);
    expect(ok).toMatchObject({ reconciled: true, matched: 2, uninvoicedInrPayments: ['pay_b'] });
    const bad = await reconcile('razorpay', readProviderCsv('id,amount,currency,status\npay_a,98.00,INR,captured\npay_z,5.00,INR,captured\n'), from, to);
    expect(bad).toMatchObject({ reconciled: false, differences: { amountMismatch: ['pay_a'], missingLocally: ['pay_z'], missingAtProvider: ['pay_b'] } });

    await Subscription.insertMany([
      { userId: user, plan: 'pro', interval: 'month', provider: 'razorpay', providerSubscriptionId: 's1', status: 'active', currentPeriodEnd: new Date(now.getTime() + 20 * DAY), createdAt: new Date(now.getTime() - 60 * DAY) },
      { userId: other, plan: 'pro_plus', interval: 'year', provider: 'razorpay', providerSubscriptionId: 's2', status: 'cancelled', currentPeriodEnd: new Date(now.getTime() - 5 * DAY), createdAt: new Date(now.getTime() - 400 * DAY) },
    ]);
    const m = await revenueMetrics({ from: new Date(now.getTime() - 30 * DAY), to: new Date(now.getTime() + 1000), marketingSpend: 1_00_000 });
    expect(m).toMatchObject({ activeSubscriptions: 1, mrrInr: 29_900, arrInr: 3_58_800, revenue: { INR: 39_800 }, payingUsers: 2, newPayingUsers: 2, monthlyChurn: 0.5, cacInr: 50_000 });
    const rows = await analyticsRows('a-long-enough-salt-value');
    expect(rows.payments).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(String(user));
    await expect(analyticsRows('short')).rejects.toThrow();
  });
});
