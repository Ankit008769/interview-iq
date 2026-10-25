// Compiles and runs one untrusted program. On Linux every step goes through iq-sandbox (limits, unprivileged
// user, seccomp filter without network); RUNNER_MODE=local-unsafe runs commands directly for development on
// a laptop and must only ever listen on loopback.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile, readdir, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const VERSION = 'iq-runner.v1';
export const LOCAL_UNSAFE = process.env.RUNNER_MODE === 'local-unsafe';
const WINDOWS = process.platform === 'win32';
const SANDBOX = process.env.IQ_SANDBOX_BIN || '/usr/local/bin/iq-sandbox';
const ROOT = LOCAL_UNSAFE ? join(tmpdir(), 'iq-runner') : (process.env.RUNNER_WORK_ROOT || '/sandbox');
const MB = 1024 * 1024;
export const LIMITS = { sourceBytes: 128 * 1024, stdinBytes: 4 * MB, stdoutBytes: 8 * MB, stderrBytes: 32 * 1024, maxRunMs: 15_000, compileMs: 20_000 };

const bin = (linux, local) => (LOCAL_UNSAFE ? local : linux);
const python = WINDOWS ? 'python' : 'python3';
// as: address-space limit for the program (0 = none; Node and the JVM reserve large virtual ranges and are
// bounded by their own heap flags instead). nproc counts threads, which the JVM and Node need.
export const LANGUAGES = {
  javascript: { file: 'main.js', nproc: 32, as: 0,
    run: () => [bin('/usr/local/bin/node', process.execPath), '--max-old-space-size=256', '--stack-size=50000', 'main.js'] },
  typescript: { file: 'main.ts', nproc: 32, as: 0,
    run: () => [bin('/usr/local/bin/node', process.execPath), '--max-old-space-size=256', '--stack-size=50000', '--disable-warning=ExperimentalWarning', 'main.ts'] },
  python: { file: 'main.py', nproc: 16, as: 768 * MB,
    run: () => [bin('/usr/bin/python3', python), '-I', '-B', '-X', 'utf8', 'main.py'] },
  java: { file: 'Main.java', nproc: 64, as: 0,
    compile: () => [bin('/usr/bin/javac', 'javac'), '-J-Xshare:auto', '-J-XX:TieredStopAtLevel=1', '-J-XX:+UseSerialGC', '-J-Xmx384m', '-J-XX:-UsePerfData', '-encoding', 'UTF-8', '-nowarn', 'Main.java'],
    run: () => [bin('/usr/bin/java', 'java'), '-Xmx256m', '-Xss64m', '-XX:+UseSerialGC', '-XX:TieredStopAtLevel=1', '-XX:-UsePerfData', '-Xshare:auto',
      '-XX:MaxDirectMemorySize=32m', '-XX:ReservedCodeCacheSize=64m', '-cp', '.', 'Main'] },
  cpp: { file: 'main.cpp', nproc: 16, as: 768 * MB,
    compile: () => [bin('/usr/bin/g++', 'g++'), '-std=c++17', '-O2', '-pipe', ...(LOCAL_UNSAFE ? [] : ['-include', '/opt/iq/pch/stdc++.h']), 'main.cpp', '-o', WINDOWS ? 'main.exe' : 'main'],
    run: dir => [WINDOWS ? join(dir, 'main.exe') : './main'] },
};

// Which languages this machine can actually run (a laptop may lack Java, for example).
export function availableLanguages() {
  return Object.fromEntries(Object.entries(LANGUAGES).map(([name, lang]) => {
    const tool = (lang.compile ?? lang.run)()[0];
    const probe = spawnSync(tool, [tool.endsWith('javac') || tool.endsWith('java') ? '-version' : '--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    const text = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.split(/\r?\n/).find(Boolean)?.trim();
    return [name, probe.status === 0 && text ? text.slice(0, 80) : null];
  }));
}

function collect(stream, cap) {
  const chunks = []; let size = 0; let truncated = false;
  stream.on('data', chunk => {
    if (size >= cap) { truncated = true; return; }
    const room = cap - size;
    chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
    size += Math.min(chunk.length, room);
    if (chunk.length > room) truncated = true;
  });
  const result = () => ({ text: Buffer.concat(chunks).toString('utf8'), truncated });
  result.truncated = () => truncated;
  return result;
}

// Runs one step with a wall-clock limit; the CPU limit inside the sandbox is the backstop.
function step(argv, { dir, timeMs, stdin = '', nproc, as, stdoutCap, env = {} }) {
  return new Promise(resolve => {
    const vars = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: dir, TMPDIR: dir, LANG: 'C.UTF-8', ...env };
    const cpu = String(Math.ceil(timeMs / 1000) + 1);
    const [command, ...args] = LOCAL_UNSAFE ? argv : [SANDBOX, '--dir', dir, '--cpu', cpu, ...(as ? ['--as', String(as)] : []), '--nproc', String(nproc),
      '--fsize', String(32 * MB), ...Object.entries(vars).flatMap(([k, v]) => ['--env', `${k}=${v}`]), '--', ...argv];
    const started = performance.now();
    const child = spawn(command, args, { cwd: dir, env: LOCAL_UNSAFE ? { ...process.env, ...vars, PATH: process.env.PATH } : {}, detached: !WINDOWS, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = collect(child.stdout, stdoutCap ?? LIMITS.stdoutBytes);
    const err = collect(child.stderr, LIMITS.stderrBytes);
    let killedFor = null;
    const kill = reason => {
      if (killedFor) return; killedFor = reason;
      try { if (WINDOWS) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); else process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      setTimeout(finish, 3000);
    };
    const timer = setTimeout(() => kill('timeout'), timeMs);
    child.stdout.on('data', () => { if (out.truncated()) kill('output_limit'); });
    child.on('error', () => kill('spawn'));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
    // A killed process's children can keep the output pipes open, so the step also ends shortly after the
    // process itself exits or is killed, without waiting for the pipes to close.
    let done = false, exit = { code: null, signal: null };
    const finish = () => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(grace);
      child.stdout.destroy(); child.stderr.destroy();
      resolve({ ms: Math.round(performance.now() - started), exitCode: exit.code, signal: exit.signal, killedFor, stdout: out(), stderr: err() });
    };
    let grace;
    child.on('exit', (code, signal) => { exit = { code, signal }; grace = setTimeout(finish, 1500); });
    child.on('close', (code, signal) => { exit = { code: code ?? exit.code, signal: signal ?? exit.signal }; finish(); });
  });
}

const MEMORY_PATTERNS = /MemoryError|OutOfMemoryError|std::bad_alloc|heap out of memory|Cannot allocate memory|Allocation failed/;
function classify(result) {
  if (result.killedFor === 'timeout' || result.signal === 'SIGXCPU') return 'timeout';
  if (result.killedFor === 'output_limit') return 'output_limit';
  if (MEMORY_PATTERNS.test(result.stderr.text)) return 'memory';
  if (result.exitCode === 0) return 'ok';
  return 'runtime_error';
}

// Everything the sandbox user leaves behind is removed after each run: its processes (including any that
// detached from the process group) and its files outside the run directory.
async function cleanup(dir) {
  if (!LOCAL_UNSAFE) {
    // A fork bomb can create processes while they are being killed, so repeat until none are left.
    for (let attempt = 0; attempt < 50; attempt++) {
      spawnSync('pkill', ['-KILL', '-u', '65534']);
      if (spawnSync('pgrep', ['-u', '65534']).status === 1) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    for (const shared of ['/tmp', '/var/tmp', '/dev/shm']) {
      if (existsSync(shared)) spawnSync('find', [shared, '-mindepth', '1', '-user', '65534', '-delete']);
    }
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
}

export async function run({ language, source, stdin = '', timeLimitMs = 5000 }) {
  const lang = LANGUAGES[language];
  if (!lang) return { status: 'invalid', error: 'Unsupported language.' };
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > LIMITS.sourceBytes) return { status: 'invalid', error: 'Source must be 1 byte to 128 KB.' };
  if (typeof stdin !== 'string' || Buffer.byteLength(stdin) > LIMITS.stdinBytes) return { status: 'invalid', error: 'Input must be at most 4 MB.' };
  const timeMs = Math.min(LIMITS.maxRunMs, Math.max(500, Math.round(Number(timeLimitMs) || 5000)));
  const dir = join(ROOT, `run-${randomBytes(8).toString('hex')}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    if (!LOCAL_UNSAFE) spawnSync('chown', ['65534:65534', dir]);
    await writeFile(join(dir, lang.file), source, { mode: 0o644 });
    if (!LOCAL_UNSAFE) spawnSync('chown', ['65534:65534', join(dir, lang.file)]);
    let compile;
    if (lang.compile) {
      const result = await step(lang.compile(), { dir, timeMs: LIMITS.compileMs, nproc: 64, as: 0, stdoutCap: 64 * 1024 });
      compile = { ms: result.ms, output: (result.stdout.text + result.stderr.text).slice(0, 16 * 1024) };
      if (result.exitCode !== 0) return { status: result.killedFor === 'timeout' ? 'compile_timeout' : 'compile_error', compile };
    }
    const result = await step(lang.run(dir), { dir, timeMs, stdin, nproc: lang.nproc, as: lang.as });
    return { status: classify(result), compile,
      run: { ms: result.ms, exitCode: result.exitCode, signal: result.signal, stdout: result.stdout.text, stdoutTruncated: result.stdout.truncated,
        stderr: result.stderr.text, stderrTruncated: result.stderr.truncated } };
  } finally {
    await cleanup(dir);
  }
}

// Proves at startup that sandboxed code cannot reach the network or the metadata server, cannot write
// outside its directory and does not run as root. The runner refuses work if any check fails.
export async function selfTest() {
  if (LOCAL_UNSAFE) return { passed: true, mode: 'local-unsafe', checks: {} };
  const probe = `
const net = require('node:net'); const fs = require('node:fs');
const attempt = (host, port) => new Promise(done => { try { const s = net.connect({ host, port, timeout: 1500 });
  s.on('connect', () => { s.destroy(); done('connected'); }); s.on('error', e => done(e.code || 'error')); s.on('timeout', () => { s.destroy(); done('timeout'); }); } catch (e) { done(e.code || 'error'); } });
(async () => {
  const checks = { uid: process.getuid(), internet: await attempt('8.8.8.8', 53), metadata: await attempt('169.254.169.254', 80) };
  try { fs.writeFileSync('/etc/iq-escape', 'x'); checks.writeEtc = 'written'; } catch (e) { checks.writeEtc = e.code; }
  try { fs.readFileSync('/proc/1/environ'); checks.readInitEnv = 'read'; } catch (e) { checks.readInitEnv = e.code; }
  console.log(JSON.stringify(checks));
})();`;
  const result = await run({ language: 'javascript', source: probe, timeLimitMs: 8000 });
  let checks = {};
  try { checks = JSON.parse(result.run?.stdout.trim().split('\n').at(-1) ?? '{}'); } catch { /* reported as failed */ }
  const passed = checks.uid === 65534 && checks.internet !== 'connected' && checks.metadata !== 'connected'
    && checks.writeEtc !== 'written' && checks.readInitEnv !== 'read';
  return { passed, mode: 'sandbox', checks, status: result.status };
}

export async function prepareWorkRoot() {
  await mkdir(ROOT, { recursive: true, mode: 0o711 });
  // Leftovers from a crashed previous process.
  for (const name of await readdir(ROOT)) {
    const path = join(ROOT, name);
    if ((await lstat(path)).isDirectory()) await rm(path, { recursive: true, force: true });
  }
}
