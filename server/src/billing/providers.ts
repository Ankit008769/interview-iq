import type { Interval, PackId } from './plans.js';
import type { Provider } from '../models/Billing.js';

// Payment providers (roadmap D5): Razorpay for India (UPI, cards, netbanking) and Stripe for international
// cards. Both are used through their hosted pages (Razorpay payment links and subscription links, Stripe
// Checkout), so card and UPI details never touch Interview IQ's pages and no third-party script is loaded.
// Nothing here works until the keys are configured; until then checkout reports "payments are not enabled".

type PaidPlan = 'pro' | 'pro_plus';
const env = (name: string) => process.env[name]?.trim() || undefined;
const planKey = (plan: PaidPlan, interval: Interval) => `${plan === 'pro' ? 'PRO' : 'PRO_PLUS'}_${interval === 'month' ? 'MONTH' : 'YEAR'}`;

export function configured(provider: Provider) {
  return provider === 'razorpay' ? !!(env('RAZORPAY_KEY_ID') && env('RAZORPAY_KEY_SECRET') && env('RAZORPAY_WEBHOOK_SECRET'))
    : !!(env('STRIPE_SECRET_KEY') && env('STRIPE_WEBHOOK_SECRET'));
}
export const webhookSecret = (provider: Provider) => (provider === 'razorpay' ? env('RAZORPAY_WEBHOOK_SECRET') : env('STRIPE_WEBHOOK_SECRET'));
export function subscriptionAvailable(provider: Provider, plan: PaidPlan, interval: Interval) {
  return configured(provider) && !!env(`${provider === 'razorpay' ? 'RAZORPAY_PLAN' : 'STRIPE_PRICE'}_${planKey(plan, interval)}`);
}
export const packAvailable = (provider: Provider, pack: PackId) => configured(provider) && (provider === 'razorpay' || !!env(`STRIPE_PRICE_${pack.toUpperCase()}`));

export class ProviderError extends Error {}
async function call(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(`Payment provider error (${res.status}).`);
  return body as Record<string, unknown>;
}

// Razorpay: Basic auth with the key ID and secret; amounts in paise.
function razorpay(path: string, body: unknown) {
  const auth = Buffer.from(`${env('RAZORPAY_KEY_ID')}:${env('RAZORPAY_KEY_SECRET')}`).toString('base64');
  return call(`${env('RAZORPAY_API_BASE') ?? 'https://api.razorpay.com'}/v1/${path}`, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
// Stripe: form-encoded with bracketed keys.
function stripe(path: string, fields: Record<string, string>) {
  return call(`${env('STRIPE_API_BASE') ?? 'https://api.stripe.com'}/v1/${path}`, { method: 'POST',
    headers: { Authorization: `Bearer ${env('STRIPE_SECRET_KEY')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
}

export type CheckoutRequest = { intentId: string; userId: string; email: string; name: string; returnUrl: string } & (
  | { kind: 'subscription'; plan: PaidPlan; interval: Interval; offer?: string }
  | { kind: 'pack'; packId: PackId; amount: number; description: string });

// Returns the provider's reference (payment link, subscription or session ID) and the hosted page to open.
export async function startCheckout(provider: Provider, r: CheckoutRequest): Promise<{ ref: string; url: string }> {
  if (provider === 'razorpay') {
    if (r.kind === 'pack') {
      const link = await razorpay('payment_links', { amount: r.amount, currency: 'INR', description: r.description, reference_id: r.intentId,
        customer: { name: r.name, email: r.email }, notify: { email: false, sms: false }, callback_url: r.returnUrl, callback_method: 'get', notes: { intentId: r.intentId } });
      return { ref: String(link.id), url: String(link.short_url) };
    }
    const sub = await razorpay('subscriptions', { plan_id: env(`RAZORPAY_PLAN_${planKey(r.plan, r.interval)}`), total_count: r.interval === 'month' ? 120 : 10, customer_notify: 1,
      notes: { intentId: r.intentId }, ...(r.offer ? { offer_id: r.offer } : {}) });
    return { ref: String(sub.id), url: String(sub.short_url) };
  }
  const price = r.kind === 'pack' ? env(`STRIPE_PRICE_${r.packId.toUpperCase()}`) : env(`STRIPE_PRICE_${planKey(r.plan, r.interval)}`);
  const session = await stripe('checkout/sessions', {
    mode: r.kind === 'pack' ? 'payment' : 'subscription', 'line_items[0][price]': price ?? '', 'line_items[0][quantity]': '1',
    client_reference_id: r.intentId, customer_email: r.email, 'metadata[intentId]': r.intentId, success_url: r.returnUrl, cancel_url: r.returnUrl,
    ...(r.kind === 'subscription' ? { 'subscription_data[metadata][intentId]': r.intentId } : {}),
    ...(r.kind === 'subscription' && r.offer ? { 'discounts[0][promotion_code]': r.offer } : {}),
  });
  return { ref: String(session.id), url: String(session.url) };
}

export async function cancelSubscription(provider: Provider, id: string) {
  if (provider === 'razorpay') await razorpay(`subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: 1 });
  else await stripe(`subscriptions/${encodeURIComponent(id)}`, { cancel_at_period_end: 'true' });
}
