import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { makeTeam, write, lines } from '../testlib/repos.js';
import { startDaemon, stopDaemon } from '../src/daemon.js';
import { pidAlive } from '../src/workspace.js';

const HTML = fs.readFileSync(fileURLToPath(new URL('../src/gui.html', import.meta.url)), 'utf8');
const script = HTML.match(/<script>([\s\S]*)<\/script>/)[1];

const get = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  }).on('error', reject);
});

test('page has no external requests, a dark theme, and a phone viewport', () => {
  assert.doesNotMatch(HTML, /https?:\/\//);
  assert.doesNotMatch(HTML, /<(link|img|iframe)\b|@import|src=/);
  assert.match(HTML, /:root\s*{[^}]*--conflict:/);
  assert.match(HTML, /prefers-color-scheme: dark/);
  assert.match(HTML, /name="viewport" content="width=device-width/);
  assert.doesNotMatch(HTML, /[–—]/);
  assert.doesNotMatch(script, /innerHTML/);
});

test('page script renders a state without errors, using text only', () => {
  const node = (tag) => ({
    tag, children: [], attrs: {}, className: '', textContent: '',
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...c) { this.children = c; },
  });
  const app = node('div');
  const meta = node('div');
  const text = (n) => (typeof n === 'string' ? n : n.nodeValue ?? (n.textContent || '') + n.children.map(text).join(' '));
  const document = {
    createElement: node,
    createTextNode: (s) => ({ nodeValue: s, children: [] }),
    getElementById: (id) => (id === 'app' ? app : meta),
    querySelectorAll: () => [],
  };
  const timers = [];
  const iso = new Date().toISOString();
  const ws = (over) => ({ id: 'a/1', name: 'alice', email: '', branch: 'main', task: '<img src=x onerror=alert(1)>', agent: true, updatedAt: iso, files: ['auth.js', 'util.js'], mine: false, ...over });
  const state = {
    version: 1, generatedAt: iso, me: ws({ id: 'b/2', name: 'bob', mine: true }), others: [ws({})],
    clashes: [{ with: 'a/1', files: ['auth.js', 'util.js'], conflicts: ['auth.js'] }],
    notShared: [{ path: 'creds.txt', reason: 'secret-looking file name' }], daemon: { lastError: 'offline' },
  };
  const ctx = vm.createContext({
    document, Date, Math, String, Set, Promise, console,
    fetch: async () => ({ ok: true, json: async () => state }),
    setInterval: (fn) => timers.push(fn),
  });
  vm.runInContext(script, ctx);
  ctx.render(state);
  const all = text({ textContent: '', children: [...app.children, ...meta.children] });
  assert.match(all, /CONFLICT/);
  assert.match(all, /You and alice/);
  assert.match(all, /creds\.txt/);
  assert.match(all, /secret-looking file name/);
  assert.match(all, /updated 0s ago/);
  assert.match(all, /Last sync problem: offline/);
  assert.match(all, /<img src=x onerror=alert\(1\)>/, 'peer text is shown as text, not markup');
  ctx.render({ ...state, others: [], clashes: [], notShared: [], daemon: {} });
  assert.match(text({ textContent: '', children: app.children }), /Nobody else is changing/);
  ctx.showOffline('down');
  assert.match(text({ textContent: '', children: [...app.children, ...meta.children] }), /down.*not connected/);
});

test('the process serves the page and /api/state over localhost', async () => {
  process.env.AIRSPACE_INTERVAL_MS = '1000';
  const t = makeTeam(['alice']);
  let pid;
  try {
    const { info } = await startDaemon(t.clones.alice);
    pid = info.pid;
    write(t.clones.alice, 'auth.js', lines(12, ' x'));
    const page = await get(info.port, '/');
    assert.equal(page.status, 200);
    assert.equal(page.body, HTML);
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    const api = await get(info.port, '/api/state');
    assert.equal(api.status, 200);
    assert.equal(JSON.parse(api.body).version, 1);
  } finally {
    await stopDaemon(t.clones.alice);
    if (pid && pidAlive(pid)) process.kill(pid, 'SIGKILL');
    delete process.env.AIRSPACE_INTERVAL_MS;
    t.cleanup();
  }
});
