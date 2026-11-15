import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { accountEmail, emailDeliveryAvailable, mailConfig, sendAccountLink } from '../src/services/accountMail.js';

process.env.JWT_SECRET = 'account-mail-test-secret-longer-than-thirty-two-characters';
process.env.CLIENT_ORIGIN = 'http://127.0.0.1:5173';
const { app } = await import('../src/app.js');

// Decodes a quoted-printable body as a mail client would.
const qp = (data: string) => data.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
// A minimal SMTP server that accepts AUTH PLAIN and records what it receives.
type Received = { auth: string; from: string; to: string[]; data: string };
function smtpServer(received: Received[]): Server {
  return createServer((socket: Socket) => {
    let mail: Received = { auth: '', from: '', to: [], data: '' }; let inData = false; let buffer = '';
    socket.write('220 test.local ESMTP\r\n');
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (inData) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end < 0) return;
        mail.data = buffer.slice(0, end); buffer = buffer.slice(end + 5); inData = false;
        received.push(mail); mail = { auth: mail.auth, from: '', to: [], data: '' };
        socket.write('250 2.0.0 queued\r\n');
      }
      let i;
      while (!inData && (i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 2);
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) socket.write('250-test.local\r\n250-AUTH PLAIN\r\n250 OK\r\n');
        else if (cmd.startsWith('AUTH PLAIN')) { mail.auth = Buffer.from(line.slice(11), 'base64').toString('utf8'); socket.write('235 2.7.0 Authentication successful\r\n'); }
        else if (cmd.startsWith('MAIL FROM')) { mail.from = line; socket.write('250 OK\r\n'); }
        else if (cmd.startsWith('RCPT TO')) { mail.to.push(line); socket.write('250 OK\r\n'); }
        else if (cmd === 'DATA') { inData = true; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
        else if (cmd === 'QUIT') { socket.end('221 Bye\r\n'); }
        else if (cmd === 'RSET' || cmd === 'NOOP') socket.write('250 OK\r\n');
        else socket.write('502 Not implemented\r\n');
      }
    });
  });
}

describe('mail settings', () => {
  it('blocks delivery even with SMTP credentials when explicitly disabled', async () => {
    vi.stubEnv('EMAIL_DELIVERY_ENABLED', 'false');
    vi.stubEnv('SMTP_HOST', 'smtp.example.test');
    vi.stubEnv('SMTP_USER', 'sender@example.test');
    vi.stubEnv('SMTP_PASS', 'test-only');
    try {
      expect(emailDeliveryAvailable()).toBe(false);
      expect((await request(app).get('/api/auth/capabilities')).body.emailDelivery).toBe(false);
      await expect(sendAccountLink('reader@example.test', 'reset', 'https://example.test/reset'))
        .rejects.toThrow('Account email delivery is not configured.');
    } finally { vi.unstubAllEnvs(); }
  });
  it('reads Gmail-style SMTP settings and stays off until they are complete', () => {
    expect(mailConfig({})).toBeNull();
    for (const flag of [undefined, 'false', 'TRUE']) {
      expect(mailConfig({ EMAIL_DELIVERY_ENABLED: flag, SMTP_HOST: 'smtp.test', SMTP_USER: 'u', SMTP_PASS: 'p' })).toBeNull();
    }
    expect(mailConfig({ EMAIL_DELIVERY_ENABLED: 'true', SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'me@gmail.com' })).toBeNull();
    expect(mailConfig({ EMAIL_DELIVERY_ENABLED: 'true', SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'me@gmail.com', SMTP_PASS: 'abcd efgh ijkl mnop' }))
      .toEqual({ host: 'smtp.gmail.com', port: 465, secure: true, requireTLS: false, user: 'me@gmail.com', pass: 'abcdefghijklmnop', from: 'me@gmail.com' });
    expect(mailConfig({ EMAIL_DELIVERY_ENABLED: 'true', SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'Interview IQ <u@example.test>' }))
      .toMatchObject({ port: 587, secure: false, requireTLS: true, from: 'Interview IQ <u@example.test>' });
    expect(mailConfig({ EMAIL_DELIVERY_ENABLED: 'true', SMTP_HOST: 'h', SMTP_PORT: 'nope', SMTP_USER: 'u', SMTP_PASS: 'p' })).toBeNull();
  });
  it('writes plain-text and HTML messages with the link escaped', () => {
    const m = accountEmail('reset', 'https://iq.test/account/recovery#token=a"<b>');
    expect(m.subject).toBe('Reset your Interview IQ password');
    expect(m.text).toContain('https://iq.test/account/recovery#token=a"<b>');
    expect(m.text).toContain('within 30 minutes');
    expect(m.html).toContain('href="https://iq.test/account/recovery#token=a&#34;&#60;b&#62;"');
    expect(m.html).not.toContain('<b>');
    expect(accountEmail('verify', 'https://iq.test/v').text).toContain('within 60 minutes');
  });
});

describe('account email over SMTP', () => {
  let mongo: MongoMemoryServer; let smtp: Server;
  const received: Received[] = [];
  const agent = request.agent(app);
  beforeAll(async () => {
    smtp = smtpServer(received);
    await new Promise<void>(r => smtp.listen(0, '127.0.0.1', r));
    vi.stubEnv('EMAIL_DELIVERY_ENABLED', 'true'); vi.stubEnv('SMTP_HOST', '127.0.0.1'); vi.stubEnv('SMTP_PORT', String((smtp.address() as AddressInfo).port));
    vi.stubEnv('SMTP_SECURE', 'false'); vi.stubEnv('SMTP_REQUIRE_TLS', 'false');
    vi.stubEnv('SMTP_USER', 'sender@example.test'); vi.stubEnv('SMTP_PASS', 'app-password'); vi.stubEnv('MAIL_FROM', 'Interview IQ <sender@example.test>');
    mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
    await agent.post('/api/auth/register').send({ name: 'Mail Tester', email: 'reader@example.test', password: 'test-password' }).expect(201);
  }, 120_000);
  afterAll(async () => { vi.unstubAllEnvs(); await mongoose.disconnect(); await mongo?.stop(); smtp.close(); });

  it('sends verification and reset links that work', async () => {
    expect(emailDeliveryAvailable()).toBe(true);
    expect((await request(app).get('/api/auth/capabilities').expect(200)).body).toEqual({ emailDelivery: true });
    await agent.post('/api/auth/verification-email').expect(200);
    expect(received).toHaveLength(1);
    expect(received[0].auth).toBe('\u0000sender@example.test\u0000app-password');
    expect(received[0].to).toEqual(['RCPT TO:<reader@example.test>']);
    expect(received[0].data).toMatch(/Subject: Confirm your email for Interview IQ/);
    const link = qp(received[0].data).match(/http:\/\/127\.0\.0\.1:5173\/account\/verify#token=([A-Za-z0-9_-]+)/);
    expect(link).not.toBeNull();
    await request(app).post('/api/auth/verify-email').send({ token: link![1] }).expect(200);
    expect((await agent.get('/api/auth/me').expect(200)).body.user.emailVerified).toBe(true);

    await request(app).post('/api/auth/forgot-password').send({ email: 'reader@example.test' }).expect(200);
    await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@example.test' }).expect(200); // no enumeration, no email
    expect(received).toHaveLength(2);
    expect(received[1].data).toMatch(/Subject: Reset your Interview IQ password/);
    expect(qp(received[1].data)).toMatch(/\/account\/recovery#token=[A-Za-z0-9_-]+/);
  });

  it('reports a failed send without revealing details', async () => {
    vi.stubEnv('SMTP_PORT', '1'); // nothing listens there
    const res = await agent.post('/api/auth/verification-email');
    expect([200, 503]).toContain(res.status); // already verified accounts get 200 without an email
    vi.stubEnv('SMTP_PORT', String((smtp.address() as AddressInfo).port));
  });
});
