#!/usr/bin/env node
// Shares the Interview IQ running on this laptop on the internet through a free Cloudflare quick tunnel
// (no Cloudflare account, no card). Anyone with the printed https://….trycloudflare.com link can open the app
// while this keeps running; the laptop does the work, local AI included.
//
//   1. Build the website once:   cd client && npm run build
//   2. Start sharing:            node deploy/share-tunnel.mjs [--port 5100] [--cloudflared path\to\cloudflared.exe]
//                                                              [--url-file path\to\SHARE-LINK.txt]
//   3. Stop with Ctrl+C. The link stops working at once.
//
// Quick-tunnel addresses are dropped by Cloudflare when the connection breaks (for example when the laptop
// sleeps), so the script checks the public link every minute and, after three failures in a row, starts a
// new tunnel and restarts the app for the new address. The current link is printed and, with --url-file,
// written to that file.
//
// The shared copy uses the same database and models as local development (server/.env). It serves the built
// site itself, sets CLIENT_ORIGIN to the tunnel address (so sign-in, writes and email links work there), forces
// Secure cookies, trusts one proxy hop so per-visitor limits see the visitor's address, and points the skill
// passport issuer at the tunnel host. Quick tunnels are meant for testing and demos, not production.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const port = Number(arg('port', '5100'));
const cloudflared = arg('cloudflared', process.env.CLOUDFLARED ?? 'cloudflared');
const urlFile = arg('url-file');
if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.error('--port must be 1024 to 65535.'); process.exit(1); }
if (!existsSync(join(root, 'client', 'dist', 'index.html'))) { console.error('Build the website first: cd client && npm run build'); process.exit(1); }

let tunnel = null, api = null, stopping = false, restarting = false;
const kill = child => { if (child && child.exitCode === null && !child.killed) child.kill(); };
const stopAll = code => { stopping = true; kill(api); kill(tunnel); if (urlFile) try { writeFileSync(urlFile, 'Sharing is stopped.\n'); } catch { /* ignore */ } process.exit(code); };
process.on('SIGINT', () => stopAll(0)); process.on('SIGTERM', () => stopAll(0));

function startTunnel() {
  return new Promise((resolve, reject) => {
    const child = spawn(cloudflared, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => { kill(child); reject(new Error('No tunnel address within 60 seconds.')); }, 60_000);
    const scan = chunk => { const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m) { clearTimeout(timer); resolve({ child, url: m[0] }); } };
    child.stdout.on('data', scan); child.stderr.on('data', scan);
    child.on('error', err => { clearTimeout(timer); reject(new Error(`Could not start cloudflared (${err.message}). Install it or pass --cloudflared <path>.`)); });
    child.on('exit', () => { if (!stopping && !restarting && child === tunnel) { console.error('cloudflared stopped; starting a new tunnel.'); void restart(); } });
  });
}
function startApi(url) {
  const env = { ...process.env, PORT: String(port), SERVE_CLIENT: 'true', CLIENT_ORIGIN: url, COOKIE_SECURE: 'true', TRUST_PROXY_HOPS: '1', PASSPORT_ISSUER_HOST: new URL(url).host };
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: join(root, 'server'), env, stdio: 'inherit', windowsHide: true });
  child.on('exit', code => { if (!stopping && !restarting && child === api) { console.error(`The app stopped (exit ${code}).`); stopAll(code ?? 1); } });
  return child;
}
async function start() {
  const t = await startTunnel();
  tunnel = t.child;
  api = startApi(t.url);
  current = t.url; startedAt = Date.now();
  if (urlFile) try { writeFileSync(urlFile, `Interview IQ is shared at:\n${t.url}\n\nStarted ${new Date().toLocaleString()}. The link works while the laptop is on and sharing is running.\n`); } catch { /* ignore */ }
  console.log(`\n  Interview IQ is shared at:  ${t.url}\n  (this laptop must stay on; press Ctrl+C to stop sharing)\n`);
}
async function restart() {
  if (restarting || stopping) return;
  restarting = true;
  kill(api); kill(tunnel);
  await new Promise(r => setTimeout(r, 2000));
  try { await start(); } catch (err) { console.error(`Restart failed: ${err.message}. Retrying in a minute.`); }
  finally { restarting = false; failures = 0; }
}

let current = '', failures = 0, startedAt = 0;
try { await start(); } catch (err) { console.error(err.message); stopAll(1); }
// Watchdog: the public address must answer; three failed checks in a row mean the tunnel is gone.
setInterval(async () => {
  // A new address can take a few minutes to resolve everywhere, so checks start three minutes after a start.
  if (restarting || stopping || !current || Date.now() - startedAt < 180_000) return;
  try {
    const res = await fetch(`${current}/api/health`, { signal: AbortSignal.timeout(20_000) });
    failures = res.ok ? 0 : failures + 1;
  } catch { failures++; }
  if (failures >= 3) { console.error(`${current} is no longer reachable; starting a new tunnel.`); await restart(); }
}, 60_000);
