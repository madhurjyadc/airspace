import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTeam, sh, write, lines } from '../testlib/repos.js';
import { startDaemon, stopDaemon, runningDaemon } from '../src/daemon.js';
import { readState } from '../src/state.js';
import { readDaemon, pidAlive } from '../src/workspace.js';

const INDEX = fileURLToPath(new URL('../index.js', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = check();
    if (v) return v;
    await sleep(200);
  }
  throw new Error('timed out waiting for condition');
}

const get = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  }).on('error', reject);
});

test('two daemons share work through the remote, serve the page, and stop cleanly', async () => {
  process.env.AIRSPACE_INTERVAL_MS = '1000';
  const t = makeTeam(['alice', 'bob']);
  const { alice, bob } = t.clones;
  const pids = [];
  try {
    const a = await startDaemon(alice);
    const b = await startDaemon(bob);
    pids.push(a.info.pid, b.info.pid);
    assert.equal(a.started, true);
    assert.equal((await startDaemon(alice)).started, false, 'start twice reuses the process');
    assert.ok(readState(alice), 'state exists as soon as start returns');

    write(alice, 'auth.js', lines(12, ' alice'));
    const seen = await until(() => readState(bob)?.others.find((o) => o.name === 'alice' && o.files.includes('auth.js')));
    assert.equal(seen.mine, false);

    write(bob, 'auth.js', lines(12, ' bob'));
    await until(() => readState(bob)?.clashes.some((c) => c.conflicts.includes('auth.js')));
    await until(() => readState(alice)?.clashes.some((c) => c.conflicts.includes('auth.js')));

    write(alice, 'creds.txt', 'ghp_' + 'z'.repeat(30));
    const withSecret = await until(() => readState(alice)?.notShared.find((n) => n.path === 'creds.txt'));
    assert.equal(withSecret.reason, 'secret-looking file name');

    const port = readDaemon(bob).port;
    const page = await get(port, '/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    const api = await get(port, '/api/state');
    assert.equal(api.status, 200);
    assert.equal(JSON.parse(api.body).me.name, 'bob');
    assert.equal((await get(port, '/nope')).status, 404);
    const bad = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { host: 'evil.example' } }, (r) => resolve(r.statusCode)));
    assert.equal(bad, 403, 'wrong Host header is refused');

    const cli = spawnSync(process.execPath, [INDEX, 'status'], { cwd: bob, encoding: 'utf8' });
    assert.match(cli.stdout, /CONFLICT with alice: auth\.js/);

    assert.match(sh(t.remote, 'for-each-ref', 'refs/airspace/'), /alice/);
    assert.ok(!sh(t.remote, 'ls-tree', '-r', 'refs/airspace/' + readState(alice).me.id).includes('creds.txt'));

    const s1 = await stopDaemon(alice);
    const s2 = await stopDaemon(alice);
    await stopDaemon(bob);
    assert.equal(s1.wasRunning, true);
    assert.equal(s2.wasRunning, false);
    assert.equal(sh(t.remote, 'for-each-ref', 'refs/airspace/'), '');
    assert.equal(runningDaemon(alice), null);
    assert.equal(pids.some(pidAlive), false);
  } finally {
    for (const dir of [alice, bob]) {
      try { await stopDaemon(dir); } catch {}
    }
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    delete process.env.AIRSPACE_INTERVAL_MS;
    t.cleanup();
  }
});

test('a daemon exits by itself when its repo disappears', async () => {
  process.env.AIRSPACE_INTERVAL_MS = '300';
  const t = makeTeam(['alice']);
  let pid;
  try {
    const { info } = await startDaemon(t.clones.alice);
    pid = info.pid;
    fs.rmSync(t.clones.alice, { recursive: true, force: true });
    await until(() => !pidAlive(pid), 10000);
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    delete process.env.AIRSPACE_INTERVAL_MS;
    t.cleanup();
  }
});
