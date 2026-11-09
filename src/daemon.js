import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ws from './workspace.js';
import { buildTree, commitSnapshot } from './snapshot.js';
import { publish, fetchPeers, removeOwn } from './sync.js';
import { buildState, writeState, readState } from './state.js';

const DEBOUNCE_MS = 1000;
const HEARTBEAT_MS = 2 * 60 * 1000;
const SELF = fileURLToPath(import.meta.url);
const GUI = path.join(path.dirname(SELF), 'gui.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const daemonFile = (root) => path.join(ws.airspaceDir(root), 'daemon.json');

export function runningDaemon(root) {
  const d = ws.readDaemon(root);
  return d?.alive ? d : null;
}

async function waitFor(check, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = check();
    if (v) return v;
    await sleep(50);
  }
  return null;
}

export async function startDaemon(root) {
  const existing = runningDaemon(root);
  if (existing) return { started: false, info: existing };
  const spawnedAt = Date.now();
  const child = spawn(process.execPath, [SELF, root], { cwd: root, detached: true, stdio: 'ignore' });
  child.unref();
  const info = await waitFor(() => {
    const d = ws.readDaemon(root);
    return d?.pid === child.pid ? d : null;
  }, 5000);
  // Wait for the first state so `status` works right after `start`.
  await waitFor(() => {
    const s = readState(root);
    return s && Date.parse(s.generatedAt) >= spawnedAt;
  }, 10000);
  return { started: Boolean(info), info };
}

const isDaemonProcess = (pid) => spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout.includes(SELF);

export async function stopDaemon(root) {
  const d = ws.readDaemon(root);
  let wasRunning = false;
  if (d?.alive && isDaemonProcess(d.pid)) {
    wasRunning = true;
    process.kill(d.pid, 'SIGTERM');
    const gone = await waitFor(() => !ws.pidAlive(d.pid), 5000);
    if (!gone) process.kill(d.pid, 'SIGKILL');
  }
  fs.rmSync(daemonFile(root), { force: true });
  fs.rmSync(path.join(ws.airspaceDir(root), 'state.json'), { force: true });
  const removed = removeOwn(root, ws.identity(root).id);
  return { wasRunning, removed };
}

export async function runDaemon(root) {
  const interval = Number(process.env.AIRSPACE_INTERVAL_MS) || 10000;
  const dir = ws.airspaceDir(root);
  const me = ws.identity(root);
  const logFile = path.join(dir, 'daemon.log');
  const log = (msg) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);

  const other = ws.readDaemon(root);
  if (other?.alive && other.pid !== process.pid) return;

  let lastKey = null;
  let notShared = [];
  let state = null;
  let port = null;
  let pubError = null;
  let fetchError = null;
  let lastSyncOk = null;

  const guard = (label, fn) => {
    try {
      return fn();
    } catch (e) {
      log(`${label}: ${e.message}`);
      return { ok: false, error: e.message };
    }
  };

  // A snapshot goes out only when something I share changed, or when forced as a heartbeat.
  const publishIfChanged = (force = false) => {
    const r = guard('publish', () => {
      const snap = buildTree(root);
      notShared = snap.notShared;
      const task = ws.readTask(root);
      const agent = ws.agentActive(root);
      const key = [snap.tree, task, agent].join('|');
      if (key === lastKey && !force) return { ok: true };
      commitSnapshot(root, snap, { task, agent });
      const pushed = publish(root, me.id);
      if (pushed.ok) lastKey = key;
      return pushed;
    });
    pubError = r.ok ? null : r.error;
    if (!r.ok) log(`publish: ${r.error}`);
  };

  const refresh = () => {
    guard('state', () => {
      const lastError = pubError ?? fetchError;
      if (!lastError) lastSyncOk = new Date().toISOString();
      state = buildState(root, { notShared, daemon: { pid: process.pid, port, lastSyncOk, lastError } });
      writeState(root, state);
    });
  };

  const alive = () => {
    if (!fs.existsSync(root)) return false;
    const d = ws.readDaemon(root);
    return !d || d.pid === process.pid;
  };

  const tick = () => {
    if (!alive()) return shutdown();
    publishIfChanged();
    const f = fetchPeers(root);
    fetchError = f.ok ? null : f.error;
    if (!f.ok) log(`fetch: ${f.error}`);
    refresh();
  };

  const html = fs.readFileSync(GUI);
  const server = http.createServer((req, res) => {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { res.writeHead(403).end(); return; }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const base = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    const pathname = new URL(req.url, 'http://x').pathname;
    if (pathname === '/') {
      res.writeHead(200, {
        ...base, 'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      }).end(html);
    } else if (pathname === '/api/state') {
      res.writeHead(state ? 200 : 503, { ...base, 'Content-Type': 'application/json' }).end(JSON.stringify(state ?? { error: 'starting up' }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));

  let debounce = null;
  let watcher = null;
  try {
    watcher = fs.watch(root, { recursive: true }, (_evt, filename) => {
      if (filename && (/^\.git([\\/]|$)/.test(filename) || /(^|[\\/])node_modules[\\/]/.test(filename))) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => { publishIfChanged(); refresh(); }, DEBOUNCE_MS);
    });
    watcher.on('error', (e) => log(`watch: ${e.message}`));
  } catch (e) {
    log(`watch: ${e.message}`);
  }

  const timers = [setInterval(tick, interval), setInterval(() => { publishIfChanged(true); refresh(); }, HEARTBEAT_MS)];

  function shutdown() {
    timers.forEach(clearInterval);
    clearTimeout(debounce);
    watcher?.close();
    server.close();
    const d = ws.readDaemon(root);
    if (d?.pid === process.pid) fs.rmSync(path.join(dir, 'daemon.json'), { force: true });
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  tick();
}

if (process.argv[1] === SELF) {
  runDaemon(process.argv[2]).catch((e) => {
    try { fs.appendFileSync(path.join(ws.airspaceDir(process.argv[2]), 'daemon.log'), `fatal: ${e.stack}\n`); } catch {}
    process.exit(1);
  });
}
