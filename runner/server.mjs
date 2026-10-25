// InterviewIQ code runner: a separate service that only compiles and runs candidate code. It holds no
// secrets and no database access. On Cloud Run it accepts only IAM-authenticated calls from the app's
// service account; locally (RUNNER_MODE=local-unsafe) it listens on loopback only.
import { createServer } from 'node:http';
import { LIMITS, LOCAL_UNSAFE, VERSION, availableLanguages, prepareWorkRoot, run, selfTest } from './runner.mjs';

const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || (LOCAL_UNSAFE ? '127.0.0.1' : '0.0.0.0');
if (LOCAL_UNSAFE && !['127.0.0.1', '::1', 'localhost'].includes(HOST)) {
  console.error('RUNNER_MODE=local-unsafe runs code without a sandbox and may only listen on loopback.');
  process.exit(1);
}
const MAX_BODY = LIMITS.sourceBytes + LIMITS.stdinBytes + 64 * 1024;
const state = { ready: false, busy: false, languages: {}, selfTest: null };
const log = (event, fields = {}) => console.log(JSON.stringify({ severity: event.endsWith('failure') ? 'ERROR' : 'INFO', component: 'iq-runner', event, ...fields }));

const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      send(res, state.ready ? 200 : 503, { ok: state.ready, version: VERSION, mode: LOCAL_UNSAFE ? 'local-unsafe' : 'sandbox',
        languages: state.languages, selfTest: state.selfTest }); return;
    }
    if (req.method !== 'POST' || req.url !== '/run') { send(res, 404, { error: 'Not found.' }); return; }
    if (!state.ready) { send(res, 503, { error: 'The runner is not ready.' }); return; }
    if (process.env.RUNNER_TOKEN && req.headers['x-runner-token'] !== process.env.RUNNER_TOKEN) { send(res, 401, { error: 'Unauthorized.' }); return; }
    if (state.busy) { send(res, 429, { error: 'The runner is busy. Try again.' }); return; }
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) { send(res, 415, { error: 'Send JSON.' }); return; }
    let input;
    try { input = JSON.parse(await readBody(req)); } catch (err) { send(res, err.status ?? 400, { error: err.status ? 'Request too large.' : 'Invalid JSON.' }); return; }
    if (!state.languages[input?.language]) { send(res, 400, { error: 'Unsupported language.' }); return; }
    state.busy = true;
    try {
      const result = await run(input);
      log('run', { language: input.language, status: result.status, compileMs: result.compile?.ms, runMs: result.run?.ms });
      send(res, result.status === 'invalid' ? 400 : 200, { ...result, runner: { version: VERSION } });
    } finally { state.busy = false; }
  } catch {
    log('run_failure');
    if (!res.headersSent) send(res, 500, { status: 'internal_error', error: 'The runner failed.' });
  }
});

await prepareWorkRoot();
state.languages = availableLanguages();
state.selfTest = await selfTest();
state.ready = state.selfTest.passed && Object.values(state.languages).some(Boolean);
log(state.ready ? 'runner_ready' : 'self_test_failure', { selfTest: state.selfTest, languages: state.languages });
server.listen(PORT, HOST, () => log('listening', { host: HOST, port: PORT }));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
