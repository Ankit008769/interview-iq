import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { gstinCheckChar } from '../src/billing/gst.js';
import { signRazorpay, signStripe } from '../src/billing/signatures.js';
import { BillingEvent, CheckoutIntent, Credit, Invoice, Payment, Subscription } from '../src/models/Billing.js';
import { User } from '../src/models/User.js';
import { QuotaBucket } from '../src/services/quotas.js';

process.env.JWT_SECRET = 'billing-api-test-secret-longer-than-thirty-two-characters';
const { app } = await import('../src/app.js');

// A stand-in for the providers' APIs that records what was asked of it.
const calls: { path: string; body: string; auth?: string }[] = [];
const provider = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  calls.push({ path: req.url ?? '', body, auth: req.headers.authorization });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/payment_links') res.end(JSON.stringify({ id: `plink_${calls.length}`, short_url: 'https://rzp.io/i/test' }));
  else if (req.url === '/v1/subscriptions') res.end(JSON.stringify({ id: `sub_${calls.length}`, short_url: 'https://rzp.io/i/sub' }));
  else if (req.url?.endsWith('/cancel')) res.end(JSON.stringify({ status: 'active' }));
  else if (req.url === '/v1/checkout/sessions') res.end(JSON.stringify({ id: `cs_${calls.length}`, url: 'https://checkout.stripe.com/c/pay/test' }));
  else { res.statusCode = 404; res.end('{}'); }
});
const gstin = (() => { const first = '29AAACI1234F1Z'; return first + gstinCheckChar(first); })();

describe('billing API', () => {
  let mongo: MongoMemoryServer;
  const asha = request.agent(app), ravi = request.agent(app);
  let ashaId = '';
  beforeAll(async () => {
    await new Promise<void>(r => provider.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    vi.stubEnv('RAZORPAY_API_BASE', base); vi.stubEnv('STRIPE_API_BASE', base);
    mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
    await asha.post('/api/auth/register').send({ name: 'Asha', email: 'asha@billing.test', password: 'test-password' }).expect(201);
    await ravi.post('/api/auth/register').send({ name: 'Ravi', email: 'ravi@billing.test', password: 'test-password' }).expect(201);
    ashaId = String((await User.findOne({ email: 'asha@billing.test' }).lean())!._id);
  }, 120_000);
  beforeEach(async () => {
    calls.length = 0;
    for (const m of [Payment, Subscription, Credit, Invoice, BillingEvent, CheckoutIntent]) await m.deleteMany({});
    await QuotaBucket.deleteMany({});
    for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_PLAN_PRO_MONTH', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_VOICE_5',
      'GST_SUPPLIER_NAME', 'GST_SUPPLIER_ADDRESS', 'GST_SUPPLIER_GSTIN', 'BILLING_ENFORCEMENT']) delete process.env[k];
  });
  afterAll(async () => { vi.unstubAllEnvs(); await mongoose.disconnect(); await mongo?.stop(); provider.close(); });
  const razorpayOn = () => { process.env.RAZORPAY_KEY_ID = 'rzp_test_x'; process.env.RAZORPAY_KEY_SECRET = 'key-secret'; process.env.RAZORPAY_WEBHOOK_SECRET = 'wh-secret'; process.env.RAZORPAY_PLAN_PRO_MONTH = 'plan_pro_m'; };

  it('shows plans and the beta state, and refuses checkout until payments are switched on', async () => {
    const plans = (await asha.get('/api/billing/plans').expect(200)).body;
    expect(plans.plans.map((p: { id: string }) => p.id)).toEqual(['free', 'pro', 'pro_plus']);
    expect(plans.providers).toEqual({ razorpay: false, stripe: false });
    const me = (await asha.get('/api/billing/me').expect(200)).body;
    expect(me.usage).toMatchObject({ plan: 'free', enforcing: false, used: { textInterviews: 0, voiceInterviews: 0 }, credits: 0 });
    expect(me.referral.code).toMatch(/^[A-Z2-9]{8}$/);
    expect((await asha.post('/api/billing/checkout').send({ kind: 'pack', provider: 'razorpay', packId: 'voice_5' }).expect(503)).body.error).toMatch(/not enabled/);
    await request(app).get('/api/billing/plans').expect(401);
    await request(app).post('/api/billing/webhooks/razorpay').send('{}').expect(404); // not configured: nothing listens
  });

  it('buys a pack through a hosted Razorpay page and applies the signed webhook once', async () => {
    razorpayOn();
    process.env.GST_SUPPLIER_NAME = 'Interview IQ Private Limited'; process.env.GST_SUPPLIER_ADDRESS = 'Bengaluru'; process.env.GST_SUPPLIER_GSTIN = gstin;
    const { url } = (await asha.post('/api/billing/checkout').send({ kind: 'pack', provider: 'razorpay', packId: 'voice_5' }).expect(201)).body;
    expect(url).toBe('https://rzp.io/i/test');
    expect(calls[0].auth).toBe(`Basic ${Buffer.from('rzp_test_x:key-secret').toString('base64')}`);
    const sent = JSON.parse(calls[0].body);
    expect(sent).toMatchObject({ amount: 9_900, currency: 'INR', customer: { email: 'asha@billing.test' }, notify: { email: false, sms: false } });
    const intent = await CheckoutIntent.findOne().lean();
    const body = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: intent!.providerRef, notes: sent.notes } }, payment: { entity: { id: 'pay_9', amount: 9_900, currency: 'INR' } } } });
    const hook = () => request(app).post('/api/billing/webhooks/razorpay').set('Content-Type', 'application/json').set('x-razorpay-event-id', 'evt_9');
    await hook().set('x-razorpay-signature', signRazorpay(body, 'wrong')).send(body).expect(400);
    await hook().set('x-razorpay-signature', signRazorpay(body, 'wh-secret')).send(body.replace('9900', '1')).expect(400);
    expect((await hook().set('x-razorpay-signature', signRazorpay(body, 'wh-secret')).send(body).expect(200)).body).toEqual({ received: true, duplicate: false });
    expect((await hook().set('x-razorpay-signature', signRazorpay(body, 'wh-secret')).send(body).expect(200)).body).toEqual({ received: true, duplicate: true });
    const me = (await asha.get('/api/billing/me').expect(200)).body;
    expect(me.usage.credits).toBe(5);
    expect(me.payments).toEqual([expect.objectContaining({ kind: 'pack', amount: 9_900, status: 'captured', invoiceId: expect.any(String) })]);
    // The invoice opens only for its recipient.
    const html = (await asha.get(`/api/billing/invoices/${me.payments[0].invoiceId}`).expect(200)).text;
    expect(html).toContain('Tax invoice'); expect(html).toContain(gstin); expect(html).toContain('CGST 9% + SGST 9%'); expect(html).toContain('99.00');
    await ravi.get(`/api/billing/invoices/${me.payments[0].invoiceId}`).expect(404);
  });

  it('starts subscriptions with Razorpay and Stripe and cancels at the period end', async () => {
    razorpayOn();
    await asha.post('/api/billing/checkout').send({ kind: 'subscription', provider: 'razorpay', plan: 'pro', interval: 'year' }).expect(503); // no yearly plan ID
    expect((await asha.post('/api/billing/checkout').send({ kind: 'subscription', provider: 'razorpay', plan: 'pro', interval: 'month' }).expect(201)).body.url).toBe('https://rzp.io/i/sub');
    expect(JSON.parse(calls.at(-1)!.body)).toMatchObject({ plan_id: 'plan_pro_m', total_count: 120 });
    process.env.STRIPE_SECRET_KEY = 'sk_test_x'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_s'; process.env.STRIPE_PRICE_VOICE_5 = 'price_v5';
    expect((await ravi.post('/api/billing/checkout').send({ kind: 'pack', provider: 'stripe', packId: 'voice_5' }).expect(201)).body.url).toMatch(/checkout\.stripe\.com/);
    const form = new URLSearchParams(calls.at(-1)!.body);
    expect(Object.fromEntries(form)).toMatchObject({ mode: 'payment', 'line_items[0][price]': 'price_v5', customer_email: 'ravi@billing.test' });
    const intent = await CheckoutIntent.findOne({ provider: 'stripe' }).lean();
    const event = JSON.stringify({ id: 'evt_s1', type: 'checkout.session.completed', data: { object: { id: intent!.providerRef, mode: 'payment', payment_status: 'paid', metadata: { intentId: String(intent!._id) }, payment_intent: 'pi_1', amount_total: 199, currency: 'usd' } } });
    const t = Math.floor(Date.now() / 1000);
    await request(app).post('/api/billing/webhooks/stripe').set('Content-Type', 'application/json').set('stripe-signature', signStripe(event, 'whsec_s', t - 600)).send(event).expect(400);
    await request(app).post('/api/billing/webhooks/stripe').set('Content-Type', 'application/json').set('stripe-signature', signStripe(event, 'whsec_s', t)).send(event).expect(200);
    expect(await Payment.findOne({ provider: 'stripe' }).lean()).toMatchObject({ currency: 'USD', amount: 199 });
    // Cancelling keeps access to the end of the paid period.
    const sub = await Subscription.create({ userId: new mongoose.Types.ObjectId(ashaId), plan: 'pro', interval: 'month', provider: 'razorpay', providerSubscriptionId: 'sub_live', status: 'active', currentPeriodEnd: new Date(Date.now() + 10 * 86_400_000) });
    expect((await asha.get('/api/billing/me').expect(200)).body.usage.plan).toBe('pro');
    await asha.post('/api/billing/subscription/cancel').expect(200);
    expect(calls.at(-1)!.path).toBe('/v1/subscriptions/sub_live/cancel');
    expect((await Subscription.findById(sub._id).lean())!.cancelAtPeriodEnd).toBe(true);
    expect((await asha.post('/api/billing/checkout').send({ kind: 'subscription', provider: 'razorpay', plan: 'pro', interval: 'month' }).expect(409)).body.error).toMatch(/already have a subscription/);
  });

  it('blocks plan features with 402 only when enforcement is on', async () => {
    const start = (agent: typeof asha) => agent.post('/api/interviews').send({ mode: 'practice', role: 'Developer', type: 'HR', difficulty: 'Beginner', topic: 'General', totalQuestions: 2 });
    await start(asha).expect(201);
    process.env.BILLING_ENFORCEMENT = 'on';
    await start(asha).expect(201); // practice interviews are always free
    const blocked = await asha.post('/api/design/sessions').send({ promptId: 'url-shortener' }).expect(402);
    expect(blocked.body).toMatchObject({ code: 'PLAN_REQUIRED', plan: 'pro_plus', capability: 'system_design' });
    await asha.post('/api/projects').set('Content-Type', 'application/zip').send(Buffer.from('PK')).expect(402);
    await asha.put('/api/learning/plan').send({ interviewDate: new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10), types: ['HR'], minutesPerDay: 20 }).expect(402);
    // With Pro+ the same requests get past the plan check.
    await Subscription.create({ userId: new mongoose.Types.ObjectId(ashaId), plan: 'pro_plus', interval: 'month', provider: 'razorpay', providerSubscriptionId: 'sub_pp', status: 'active', currentPeriodEnd: new Date(Date.now() + 86_400_000) });
    expect((await asha.post('/api/design/sessions').send({ promptId: 'url-shortener' })).status).not.toBe(402);
  });

  it('takes a referral code once, from a new member', async () => {
    const code = (await asha.get('/api/billing/me').expect(200)).body.referral.code;
    await asha.post('/api/billing/referral').send({ code }).expect(400);
    expect((await ravi.post('/api/billing/referral').send({ code }).expect(201)).body).toEqual({ saved: true, reward: 3 });
    await ravi.post('/api/billing/referral').send({ code }).expect(409);
    expect((await ravi.get('/api/billing/me').expect(200)).body.referral.usedCode).toBe(true);
  });
});
