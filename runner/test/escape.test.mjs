// Sandbox escape suite. Runs inside the runner image as root (docker run IMAGE node --test test/escape.test.mjs), the same
// way the server runs, and tries what hostile code would try. Every attempt must fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { run, selfTest } from '../runner.mjs';

const lastLine = result => (result.run?.stdout ?? '').trim().split('\n').at(-1) ?? '';
const json = result => JSON.parse(lastLine(result));
// Killed processes disappear once tini (PID 1) reaps them, which can take a moment.
const noSandboxProcesses = async () => { for (let i = 0; i < 100; i++) { if (spawnSync('pgrep', ['-u', '65534']).status === 1) return true; await new Promise(r => setTimeout(r, 20)); } return false; };

test('the start-up self-test passes', async () => {
  const result = await selfTest();
  assert.equal(result.passed, true, JSON.stringify(result));
});

test('every language compiles and runs', async () => {
  const programs = {
    javascript: 'console.log("hi")', typescript: 'const n: number = 1; console.log("hi")', python: 'print("hi")',
    java: 'public class Main { public static void main(String[] a) { System.out.println("hi"); } }',
    cpp: '#include <cstdio>\nint main() { std::puts("hi"); }',
  };
  for (const [language, source] of Object.entries(programs)) {
    const result = await run({ language, source, timeLimitMs: 8000 });
    assert.equal(result.status, 'ok', `${language}: ${JSON.stringify(result)}`);
    assert.equal(result.run.stdout.trim(), 'hi');
    console.log(`${language}: compile ${result.compile?.ms ?? 0} ms, run ${result.run.ms} ms`);
  }
});

test('compile errors are reported, not run', async () => {
  for (const [language, source] of [['java', 'public class Main { void f() { int x = } }'], ['cpp', 'int main() { return }']]) {
    const result = await run({ language, source });
    assert.equal(result.status, 'compile_error', language);
    assert.ok(result.compile.output.length > 0);
  }
});

test('network sockets are refused in every runtime, including the metadata server', async () => {
  const js = await run({ language: 'javascript', timeLimitMs: 8000, source: `
const net = require('node:net');
const attempt = (host, port) => new Promise(done => { const s = net.connect({ host, port, timeout: 1500 });
  s.on('connect', () => { s.destroy(); done('connected'); }); s.on('error', e => done(e.code)); s.on('timeout', () => done('timeout')); });
(async () => {
  let fetched; try { await fetch('http://169.254.169.254/computeMetadata/v1/', { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(2000) }); fetched = 'fetched'; } catch (e) { fetched = 'refused'; }
  console.log(JSON.stringify({ dns: await attempt('8.8.8.8', 53), metadata: await attempt('169.254.169.254', 80), v6: await attempt('2001:4860:4860::8888', 53), fetched }));
})();` });
  const checks = json(js);
  assert.notEqual(checks.dns, 'connected'); assert.notEqual(checks.metadata, 'connected'); assert.notEqual(checks.v6, 'connected');
  assert.equal(checks.fetched, 'refused');

  const py = await run({ language: 'python', source: `
import socket, json
out = {}
for name, family in (('inet', socket.AF_INET), ('inet6', socket.AF_INET6)):
    try:
        socket.socket(family, socket.SOCK_STREAM); out[name] = 'created'
    except OSError as e:
        out[name] = e.errno
a, b = socket.socketpair()
out['unix'] = 'ok'
print(json.dumps(out))` });
  assert.deepEqual(json(py), { inet: 13, inet6: 13, unix: 'ok' });
});

test('privileged and namespace syscalls are refused', async () => {
  const result = await run({ language: 'cpp', source: `
#include <cstdio>
#include <cerrno>
#include <sched.h>
#include <signal.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/ptrace.h>
#include <sys/mount.h>
#include <sys/syscall.h>
#include <linux/netlink.h>
#include <linux/if_packet.h>
int main() {
  int inet = socket(AF_INET, SOCK_STREAM, 0); int e1 = errno;
  int netlink = socket(AF_NETLINK, SOCK_RAW, NETLINK_ROUTE); int e2 = errno;
  int packet = socket(AF_PACKET, SOCK_RAW, 0); int e3 = errno;
  int un = unshare(CLONE_NEWUSER | CLONE_NEWNET); int e4 = errno;
  long tr = ptrace(PTRACE_TRACEME, 0, 0, 0); int e5 = errno;
  long ur = syscall(__NR_io_uring_setup, 8, nullptr); int e6 = errno;
  int mo = mount("none", "/tmp", "tmpfs", 0, nullptr); int e7 = errno;
  long cl = syscall(SYS_clone, CLONE_NEWNET | SIGCHLD, 0, 0, 0, 0); int e8 = errno;
  int su = setuid(0); int e9 = errno;
  std::printf("{\\"inet\\":[%d,%d],\\"netlink\\":[%d,%d],\\"packet\\":[%d,%d],\\"unshare\\":[%d,%d],\\"ptrace\\":[%ld,%d],\\"io_uring\\":[%ld,%d],\\"mount\\":[%d,%d],\\"clone\\":[%ld,%d],\\"setuid\\":[%d,%d]}\\n",
    inet, e1, netlink, e2, packet, e3, un, e4, tr, e5, ur, e6, mo, e7, cl, e8, su, e9);
}` });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  const r = json(result);
  for (const key of ['inet', 'netlink', 'packet']) assert.deepEqual(r[key], [-1, 13], key);
  for (const key of ['unshare', 'ptrace', 'io_uring', 'mount', 'clone', 'setuid']) { assert.equal(r[key][0], -1, key); assert.equal(r[key][1], 1, key); }
});

test('code runs as the unprivileged sandbox user with a clean environment', async () => {
  const result = await run({ language: 'python', source: `
import os, json
out = {'uid': os.getuid(), 'euid': os.geteuid(), 'gid': os.getgid(), 'groups': os.getgroups(), 'env': sorted(os.environ)}
try:
    os.setuid(0); out['setuid'] = 'root'
except PermissionError:
    out['setuid'] = 'refused'
with open('/proc/self/status') as f:
    out['noNewPrivs'] = [l.split()[1] for l in f if l.startswith('NoNewPrivs')][0]
print(json.dumps(out))` });
  assert.deepEqual(json(result), { uid: 65534, euid: 65534, gid: 65534, groups: [], env: ['HOME', 'LANG', 'PATH', 'TMPDIR'], setuid: 'refused', noNewPrivs: '1' });
});

test('code cannot write outside its directory or read other runs and the server', async () => {
  const result = await run({ language: 'python', source: `
import os, json
out = {}
for path in ('/etc/iq', '/usr/local/bin/iq', '/app/iq', '/sandbox/iq', '/opt/iq/pch/iq'):
    try:
        open(path, 'w').write('x'); out[path] = 'written'
    except OSError as e:
        out[path] = e.errno
for path in ('/sandbox', '/root'):
    try:
        os.listdir(path); out['list ' + path] = 'listed'
    except OSError as e:
        out['list ' + path] = e.errno
try:
    open('/proc/1/environ').read(); out['environ'] = 'read'
except OSError as e:
    out['environ'] = e.errno
open('own-file', 'w').write('fine')
out['own'] = open('own-file').read()
print(json.dumps(out))` });
  const r = json(result);
  for (const [key, value] of Object.entries(r)) if (key !== 'own') assert.ok(typeof value === 'number', `${key}: ${value}`);
  assert.equal(r.own, 'fine');
});

test('time, output, file-size and memory limits stop runaway programs', async () => {
  const loop = await run({ language: 'javascript', source: 'while (true) {}', timeLimitMs: 1000 });
  assert.equal(loop.status, 'timeout'); assert.ok(loop.run.ms < 5000, `ms ${loop.run.ms}`);
  const sleeper = await run({ language: 'python', source: 'import time\ntime.sleep(60)', timeLimitMs: 1000 });
  assert.equal(sleeper.status, 'timeout');
  const flood = await run({ language: 'python', source: 'while True:\n    print("x" * 10000)', timeLimitMs: 8000 });
  assert.equal(flood.status, 'output_limit');
  const disk = await run({ language: 'python', source: "with open('big', 'wb') as f:\n    f.write(b'0' * (64 * 1024 * 1024))" });
  assert.equal(disk.status, 'runtime_error');
  const pyMemory = await run({ language: 'python', source: 'block = bytearray(2 * 1024 ** 3)' });
  assert.equal(pyMemory.status, 'memory');
  const cppMemory = await run({ language: 'cpp', source: '#include <vector>\nint main() { std::vector<char> v(3ull << 30, 1); return v[5]; }' });
  assert.equal(cppMemory.status, 'memory');
  const jsHeap = await run({ language: 'javascript', source: 'const a = []; while (true) a.push(new Array(1e6).fill(1));', timeLimitMs: 10000 });
  assert.ok(['memory', 'runtime_error'].includes(jsHeap.status), jsHeap.status);
});

test('fork bombs are contained and nothing survives a run', async () => {
  const bomb = await run({ language: 'python', source: 'import os\nwhile True:\n    try:\n        os.fork()\n    except OSError:\n        pass', timeLimitMs: 2000 });
  assert.ok(['timeout', 'runtime_error'].includes(bomb.status), bomb.status);
  assert.ok(await noSandboxProcesses(), 'sandbox processes left after a fork bomb');
  const after = await run({ language: 'python', source: 'print("still works")' });
  assert.equal(after.run.stdout.trim(), 'still works');
  const daemon = await run({ language: 'python', source: `
import os, time
if os.fork() == 0:
    os.setsid()
    if os.fork() == 0:
        time.sleep(20)
        open('/tmp/iq-daemon', 'w').write('escaped')
        os._exit(0)
    os._exit(0)
open('/tmp/iq-leftover', 'w').write('left')
print('parent done')` });
  assert.equal(daemon.status, 'ok');
  assert.ok(await noSandboxProcesses(), 'a detached daemon survived the run');
  assert.equal(existsSync('/tmp/iq-leftover'), false, 'files in /tmp survived the run');
});

test('a later run cannot see the files of an earlier run', async () => {
  await run({ language: 'python', source: "open('secret.txt', 'w').write('mine')\nprint(__import__('os').getcwd())" });
  const result = await run({ language: 'python', source: `
import glob, json
print(json.dumps(glob.glob('/sandbox/*/secret.txt') + glob.glob('/tmp/**/secret.txt', recursive=True)))` });
  assert.deepEqual(json(result), []);
});
