import { createHmac, timingSafeEqual } from 'node:crypto';

// Webhook signature checks (roadmap D5: "webhooks with idempotency"). Both are HMAC-SHA256 over the exact
// raw request body, compared in constant time; a webhook whose signature fails is never processed.

const equal = (a: string, b: string) => {
  const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};
const hmac = (secret: string, payload: Buffer | string) => createHmac('sha256', secret).update(payload).digest('hex');

// Razorpay: X-Razorpay-Signature is the hex HMAC of the body with the webhook secret.
export function verifyRazorpay(raw: Buffer, signature: string | undefined, secret: string) {
  return !!signature && /^[a-f0-9]{64}$/.test(signature) && equal(hmac(secret, raw), signature);
}
// Razorpay checkout: the payment signature is the HMAC of "order_id|payment_id" (or "payment_id|subscription_id").
export function verifyRazorpayPayment(parts: [string, string], signature: string, keySecret: string) {
  return /^[a-f0-9]{64}$/.test(signature) && equal(hmac(keySecret, `${parts[0]}|${parts[1]}`), signature);
}

// Stripe: Stripe-Signature is "t=<unix seconds>,v1=<hex>[,v1=...]"; v1 is the HMAC of "<t>.<body>". Events
// older than the tolerance are refused so a captured webhook cannot be replayed later.
export function verifyStripe(raw: Buffer, header: string | undefined, secret: string, now = Date.now(), toleranceSeconds = 300) {
  if (!header) return false;
  const parts = header.split(',').map(p => p.split('=')) as [string, string][];
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const signatures = parts.filter(([k, v]) => k === 'v1' && /^[a-f0-9]{64}$/.test(v ?? '')).map(([, v]) => v);
  if (!Number.isInteger(t) || !signatures.length || Math.abs(now / 1000 - t) > toleranceSeconds) return false;
  const expected = hmac(secret, Buffer.concat([Buffer.from(`${t}.`, 'utf8'), raw]));
  return signatures.some(s => equal(expected, s));
}
export const signStripe = (raw: string, secret: string, t: number) => `t=${t},v1=${hmac(secret, `${t}.${raw}`)}`;
export const signRazorpay = (raw: string, secret: string) => hmac(secret, raw);
