import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTeam, sh, write } from '../testlib/repos.js';
import { git } from '../src/git.js';
import * as ws from '../src/workspace.js';

test('git() reports failure instead of throwing', () => {
  const r = git(['rev-parse', '--verify', 'nope'], { cwd: ws.findRoot('.') ?? '.' });
  assert.notEqual(r.code, 0);
  assert.equal(typeof r.stderr, 'string');
});

test('identity: id is user-slug/8-hex and stable per path', () => {
  const t = makeTeam(['alice']);
  try {
    sh(t.clones.alice, 'config', 'user.name', 'Alice B. Wonder');
    const a = ws.identity(t.clones.alice);
    assert.match(a.id, /^alice-b-wonder\/[0-9a-f]{8}$/);
    assert.equal(ws.identity(t.clones.alice).id, a.id);
    sh(t.clones.alice, 'config', '--unset', 'user.name');
    assert.match(ws.identity(t.clones.alice).id, /^alice\/[0-9a-f]{8}$/);
  } finally { t.cleanup(); }
});

test('base is the merge-base with origin default, not the unpushed HEAD', () => {
  const t = makeTeam(['alice']);
  try {
    const dir = t.clones.alice;
    const pushed = sh(dir, 'rev-parse', 'HEAD');
    assert.equal(ws.baseCommit(dir), pushed);
    write(dir, 'new.js', 'x\n');
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-m', 'local only');
    assert.notEqual(sh(dir, 'rev-parse', 'HEAD'), pushed);
    assert.equal(ws.baseCommit(dir), pushed);
    assert.equal(ws.defaultBranchRef(dir), 'refs/remotes/origin/main');
  } finally { t.cleanup(); }
});

test('base falls back to HEAD with no remote default, and null with no commits', () => {
  const t = makeTeam(['alice']);
  try {
    const dir = t.clones.alice;
    sh(dir, 'remote', 'remove', 'origin');
    assert.equal(ws.baseCommit(dir), sh(dir, 'rev-parse', 'HEAD'));
    const empty = path.join(t.root, 'empty');
    fs.mkdirSync(empty);
    sh(empty, 'init');
    assert.equal(ws.baseCommit(empty), null);
  } finally { t.cleanup(); }
});

test('airspace dir is inside the git dir; task and agent files round-trip', () => {
  const t = makeTeam(['alice']);
  try {
    const dir = t.clones.alice;
    assert.ok(ws.airspaceDir(dir).startsWith(path.join(dir, '.git')));
    assert.equal(ws.readTask(dir), '');
    ws.writeTask(dir, '  fix login ');
    assert.equal(ws.readTask(dir), 'fix login');
    assert.equal(ws.agentActive(dir), false);
    ws.markAgent(dir, 1000);
    assert.equal(ws.agentActive(dir, 1000 + 5 * 60000), true);
    assert.equal(ws.agentActive(dir, 1000 + 11 * 60000), false);
  } finally { t.cleanup(); }
});
