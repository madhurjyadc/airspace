import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTeam, write, lines } from '../testlib/repos.js';
import { buildTree, commitSnapshot } from '../src/snapshot.js';
import { publish, fetchPeers } from '../src/sync.js';
import { identity, writeTask } from '../src/workspace.js';
import { buildState, writeState, readState, statePath, formatStatus, formatShow, showJson, ago } from '../src/state.js';

const INDEX = fileURLToPath(new URL('../index.js', import.meta.url));

function twoWayClash() {
  const t = makeTeam(['alice', 'bob']);
  const { alice, bob } = t.clones;
  write(alice, 'auth.js', lines(12, ' alice'));
  write(alice, 'creds.txt', 'ghp_' + 'a'.repeat(30));
  writeTask(alice, 'fix login');
  commitSnapshot(alice, buildTree(alice), { task: 'fix login', agent: true });
  publish(alice, identity(alice).id);
  write(bob, 'auth.js', lines(12, ' bob'));
  write(bob, 'util.js', lines(12, ' bob'));
  const bobSnap = buildTree(bob);
  commitSnapshot(bob, bobSnap, {});
  fetchPeers(alice);
  publish(bob, identity(bob).id);
  fetchPeers(bob);
  return { t, alice, bob, bobSnap };
}

test('buildState, write and read round-trip; formatters are plain and readable', () => {
  const { t, alice, bob } = twoWayClash();
  try {
    const state = buildState(bob, { notShared: [{ path: '.env', reason: 'secret-looking file name' }], daemon: { port: 1234 } });
    assert.equal(state.version, 1);
    assert.equal(state.me.name, 'bob');
    assert.deepEqual(state.others.map((o) => o.name), ['alice']);
    assert.deepEqual(state.clashes[0].conflicts, ['auth.js']);
    assert.equal(state.daemon.port, 1234);
    writeState(bob, state);
    assert.deepEqual(readState(bob), state);
    assert.deepEqual(fs.readdirSync(fs.realpathSync(statePath(bob) + '/..')).filter((f) => f.endsWith('.tmp')), []);

    const text = formatStatus(state);
    assert.match(text, /You: bob on main/);
    assert.match(text, /alice \(agent\) on main/);
    assert.match(text, /task: fix login/);
    assert.match(text, /CONFLICT with alice: auth\.js/);
    assert.match(text, /Not shared .*\n {2}\.env: secret-looking file name/);
    assert.doesNotMatch(text, /—|–/);

    assert.match(formatShow(state, 'ALICE'), /files \(1\):\n {4}auth\.js/);
    assert.match(formatShow(state, 'zed'), /Nobody called "zed".*Active: alice/);
    assert.equal(showJson(state, 'alice')[0].clash.conflicts[0], 'auth.js');
    assert.deepEqual(readState(alice), null);
  } finally { t.cleanup(); }
});

test('readState tolerates a missing or garbage file; ago() formats', () => {
  const t = makeTeam(['alice']);
  try {
    assert.equal(readState(t.clones.alice), null);
    fs.writeFileSync(statePath(t.clones.alice), '{nope');
    assert.equal(readState(t.clones.alice), null);
    const now = Date.now();
    assert.equal(ago(new Date(now - 7000).toISOString(), now), '7s ago');
    assert.equal(ago(new Date(now - 125000).toISOString(), now), '2m ago');
    assert.equal(ago(new Date(now - 7300000).toISOString(), now), '2h ago');
  } finally { t.cleanup(); }
});

test('CLI status, show and task read the state; they say so when nothing is running', () => {
  const t = makeTeam(['alice']);
  try {
    const dir = t.clones.alice;
    const run = (...args) => spawnSync(process.execPath, [INDEX, ...args], { cwd: dir, encoding: 'utf8' });
    let r = run('status');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not running.*airspace start/);
    assert.deepEqual(JSON.parse(run('status', '--json').stdout), { error: r.stderr.trim() });

    r = run('task', 'make', 'it', 'work');
    assert.match(r.stdout, /Task set: make it work/);
    assert.match(run('task').stdout, /make it work/);

    fs.writeFileSync(`${dir}/.git/airspace/daemon.json`, JSON.stringify({ pid: process.pid, port: 9, startedAt: 'x' }));
    r = run('status');
    assert.match(r.stderr, /starting up/);
    writeState(dir, buildState(dir));
    r = run('status');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /You: alice/);
    assert.match(r.stdout, /Nobody else is changing this repo right now/);
    assert.equal(JSON.parse(run('status', '--json').stdout).version, 1);
    assert.match(run('show', 'bob').stdout, /Nobody called "bob"/);
    assert.deepEqual(JSON.parse(run('show', 'bob', '--json').stdout), []);
    assert.equal(run('gui').stdout.trim(), 'http://127.0.0.1:9/');
    assert.equal(run('nonsense').status, 1);
    assert.match(execFileSync(process.execPath, [INDEX, 'help'], { encoding: 'utf8' }), /airspace status/);
  } finally { t.cleanup(); }
});
