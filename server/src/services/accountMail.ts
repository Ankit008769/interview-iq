import nodemailer, { type Transporter } from 'nodemailer';

// Account email: password-reset and email-verification links (verification also unlocks campus invitations).
// Any SMTP server works. The simplest free option is a Gmail account with an app password (Google Account →
// Security → 2-Step Verification → App passwords):
//   SMTP_HOST=smtp.gmail.com  SMTP_PORT=465  SMTP_USER=you@gmail.com  SMTP_PASS=<16-character app password>
//   MAIL_FROM="Interview IQ <you@gmail.com>"   (optional; defaults to SMTP_USER)
// Port 465 uses TLS from the start; other ports must upgrade with STARTTLS unless SMTP_REQUIRE_TLS=false (local
// test servers only). Delivery requires EMAIL_DELIVERY_ENABLED=true and complete SMTP settings.
// Links and tokens are never logged, and failures surface only as "could not be sent".
export type MailConfig = { host: string; port: number; secure: boolean; requireTLS: boolean; user: string; pass: string; from: string };
export function mailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig | null {
  // Explicit opt-in prevents inherited SMTP credentials from enabling delivery.
  if (env.EMAIL_DELIVERY_ENABLED !== 'true') return null;
  const host = env.SMTP_HOST?.trim(), user = env.SMTP_USER?.trim(), pass = env.SMTP_PASS?.replace(/\s+/g, '');
  if (!host || !user || !pass) return null;
  const port = Number(env.SMTP_PORT ?? 465);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const secure = env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465;
  return { host, port, secure, requireTLS: !secure && env.SMTP_REQUIRE_TLS !== 'false', user, pass, from: env.MAIL_FROM?.trim() || user };
}
export function emailDeliveryAvailable() { return !!mailConfig(); }

let cached: { key: string; transport: Transporter } | null = null;
function transportFor(c: MailConfig) {
  const key = `${c.host}|${c.port}|${c.secure}|${c.requireTLS}|${c.user}|${c.pass.length}`;
  if (!cached || cached.key !== key) {
    cached = { key, transport: nodemailer.createTransport({ host: c.host, port: c.port, secure: c.secure, requireTLS: c.requireTLS, auth: { user: c.user, pass: c.pass },
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 }) };
  }
  return cached.transport;
}

const escape = (s: string) => s.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
const COPY = {
  reset: { subject: 'Reset your Interview IQ password', intro: 'Someone asked to reset the password for this Interview IQ account. If it was you, open this link within 30 minutes:', button: 'Reset password',
    outro: 'If you did not ask for this, ignore this email; your password stays the same.' },
  verify: { subject: 'Confirm your email for Interview IQ', intro: 'Confirm that this email address belongs to your Interview IQ account by opening this link within 60 minutes:', button: 'Confirm email',
    outro: 'If you did not create an Interview IQ account, ignore this email.' },
} as const;

export function accountEmail(purpose: 'reset' | 'verify', url: string) {
  const c = COPY[purpose];
  const text = `${c.intro}\n\n${url}\n\n${c.outro}\n\nInterview IQ`;
  const html = `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;color:#111;line-height:1.5;max-width:560px">
<p>${escape(c.intro)}</p><p><a href="${escape(url)}" style="display:inline-block;background:#6d5ae6;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">${escape(c.button)}</a></p>
<p style="font-size:13px;color:#555">Or copy this link: ${escape(url)}</p><p style="font-size:13px;color:#555">${escape(c.outro)}</p><p>Interview IQ</p></body></html>`;
  return { subject: c.subject, text, html };
}

export async function sendAccountLink(email: string, purpose: 'reset' | 'verify', url: string): Promise<void> {
  const c = mailConfig();
  if (!c) throw new Error('Account email delivery is not configured.');
  const message = accountEmail(purpose, url);
  try { await transportFor(c).sendMail({ from: c.from, to: email, ...message }); }
  catch { throw new Error('The email could not be sent.'); }
}
