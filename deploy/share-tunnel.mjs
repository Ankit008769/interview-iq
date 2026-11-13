#!/usr/bin/env node
// Shares the Interview IQ running on this laptop on the internet through a free Cloudflare quick tunnel
// (no Cloudflare account, no card). Anyone with the printed https://….trycloudflare.com link can open the app
// while this keeps running; the laptop does the work, local AI included.
//
//   1. Build the website once:   cd client && npm run build
//   2. Start sharing:            node deploy/share-tunnel.mjs [--port 5100] [--cloudflared path\to\cloudflared.exe]
//   3. Stop with Ctrl+C. The link stops working at once, and each start gets a new link.
//
// The shared copy uses the same database and models as local development (server/.env). It serves the built
// site itself, sets CLIENT_ORIGIN to the tunnel address (so sign-in, writes and email links work there), forces
// Secure cookies, trusts one proxy hop so per-visitor limits see the visitor's address, and points the skill
// passport issuer at the tunnel host. Quick tunnels are meant for testing and demos, not production.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const port = Number(arg('port', '5100'));
const cloudflared = arg('cloudflared', process.env.CLOUDFLARED ?? 'cloudflared');
if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.error('--port must be 1024 to 65535.'); process.exit(1); }
if (!existsSync(join(root, 'client', 'dist', 'index.html'))) { console.error('Build the website first: cd client && npm run build'); process.exit(1); }

const children = [];
const stop = code => { for (const c of children) if (!c.killed) c.kill(); process.exit(code); };
process.on('SIGINT', () => stop(0)); process.on('SIGTERM', () => stop(0));

const tunnel = spawn(cloudflared, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
children.push(tunnel);
tunnel.on('error', err => { console.error(`Could not start cloudflared (${err.message}). Install it or pass --cloudflared <path>.`); stop(1); });
tunnel.on('exit', code => { console.error(`cloudflared stopped (exit ${code}).`); stop(1); });

const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('No tunnel address within 60 seconds.')), 60_000);
  const scan = chunk => { const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m) { clearTimeout(timer); resolve(m[0]); } };
  tunnel.stdout.on('data', scan); tunnel.stderr.on('data', scan);
}).catch(err => { console.error(err.message); stop(1); });

const env = { ...process.env, PORT: String(port), SERVE_CLIENT: 'true', CLIENT_ORIGIN: url, COOKIE_SECURE: 'true', TRUST_PROXY_HOPS: '1', PASSPORT_ISSUER_HOST: new URL(url).host };
const api = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: join(root, 'server'), env, stdio: 'inherit', windowsHide: true });
children.push(api);
api.on('exit', code => { console.error(`The app stopped (exit ${code}).`); stop(code ?? 1); });

console.log(`\n  Interview IQ is shared at:  ${url}\n  (this laptop must stay on; press Ctrl+C to stop sharing)\n`);
