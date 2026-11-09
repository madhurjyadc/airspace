import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTeam, sh, write, lines } from '../testlib/repos.js';
import { buildTree, commitSnapshot } from '../src/snapshot.js';
import { identity } from '../src/workspace.js';

const treeFiles = (dir, tree) => sh(dir, 'ls-tree', '-r', '--name-only', tree).split('\n');

test('snapshot captures edits, new files and unpushed commits without touching the repo', () => {
  const t = makeTeam(['alice']);
  try {
    const dir = t.clones.alice;
    write(dir, 'util.js', lines(12, ' committed locally'));
    sh(dir, 'add', 'util.js');
    sh(dir, 'commit', '-m', 'local');
    const local = sh(dir, 'rev-parse', 'HEAD');
    write(dir, 'auth.js', lines(12, ' edited'));
    write(dir, 'brand-new.js', 'fresh\n');
    write(dir, 'staged.js', 's\n');
    sh(dir, 'add', 'staged.js');
    const before = { status: sh(dir, 'status', '--porcelain'), head: sh(dir, 'rev-parse', 'HEAD'), index: sh(dir, 'ls-files', '-s') };

    const snap = buildTree(dir);
    const commit = commitSnapshot(dir, snap, { task: 'fix login', agent: true });

    assert.deepEqual(treeFiles(dir, snap.tree).sort(), ['README.md', 'auth.js', 'brand-new.js', 'staged.js', 'util.js']);
    assert.match(sh(dir, 'show', `${snap.tree}:auth.js`), /edited/);
    assert.match(sh(dir, 'show', `${snap.tree}:util.js`), /committed locally/);
    assert.equal(snap.base, sh(dir, 'rev-parse', 'origin/main'));
    assert.equal(sh(dir, 'rev-parse', `${commit}^`), snap.base);
    assert.throws(() => sh(dir, 'merge-base', '--is-ancestor', local, commit));
    assert.equal(sh(dir, 'rev-parse', `refs/airspace/${identity(dir).id}`), commit);
    const meta = JSON.parse(sh(dir, 'log', '-1', '--format=%s', commit));
    assert.equal(meta.airspace, 1);
    assert.equal(meta.id, identity(dir).id);
    assert.equal(meta.name, 'alice');
    assert.equal(meta.branch, 'main');
    assert.equal(meta.task, 'fix login');
    assert.equal(meta.agent, true);
    assert.ok(!Number.isNaN(Date.parse(meta.updatedAt)));

    assert.deepEqual({ status: sh(dir, 'status', '--porcelain'), head: sh(dir, 'rev-parse', 'HEAD'), index: sh(dir, 'ls-files', '-s') }, before);
    assert.deepEqual(fs.readdirSync(path.join(dir, '.git', 'airspace')).filter((f) => f.includes('index')), []);
  } finally { t.cleanup(); }
});

test('secrets are left out of the tree and listed in notShared', () => {
  const t = makeTeam(['alice']);
  try {
    const dir = t.clones.alice;
    write(dir, 'creds.txt', 'ghp_' + 'a'.repeat(30) + '\n');
    write(dir, '.env', 'FOO=1\n');
    write(dir, 'notes.txt', 'api_key = "abcdefghijkl1234"\n');
    write(dir, 'big.bin', 'x'.repeat(1024 * 1024 + 5));
    write(dir, 'private/plan.md', 'hidden\n');
    write(dir, '.airspaceignore', 'private/\n');
    write(dir, '.env.example', 'FOO=\n');
    write(dir, 'ok.js', 'fine\n');
    write(dir, 'auth.js', lines(12, ' edited'));
    write(dir, 'util.js', lines(12) + 'password = "supersecret1"\n');

    const snap = buildTree(dir);
    const files = treeFiles(dir, snap.tree);
    for (const bad of ['creds.txt', '.env', 'notes.txt', 'big.bin', 'private/plan.md']) assert.ok(!files.includes(bad), bad);
    for (const good of ['ok.js', '.env.example', '.airspaceignore', 'auth.js']) assert.ok(files.includes(good), good);
    const reasons = Object.fromEntries(snap.notShared.map((n) => [n.path, n.reason]));
    assert.equal(reasons['creds.txt'], 'secret-looking file name');
    assert.equal(reasons['.env'], 'secret-looking file name');
    assert.equal(reasons['notes.txt'], 'contains a key, token or password value');
    assert.equal(reasons['big.bin'], 'larger than 1 MB');
    assert.equal(reasons['private/plan.md'], 'listed in .airspaceignore');
    assert.equal(reasons['util.js'], 'contains a key, token or password value');
    // a modified tracked file with a secret reverts to its base version
    assert.equal(sh(dir, 'show', `${snap.tree}:util.js`), sh(dir, 'show', 'origin/main:util.js'));
    // the working file is still there
    assert.match(fs.readFileSync(path.join(dir, 'creds.txt'), 'utf8'), /ghp_/);
  } finally { t.cleanup(); }
});

test('gitignored files are skipped and a deletion shows in the tree', () => {
  const t = makeTeam(['alice']);
  try {
    const dir = t.clones.alice;
    write(dir, '.gitignore', 'out/\n');
    write(dir, 'out/a.js', 'x\n');
    fs.rmSync(path.join(dir, 'README.md'));
    const files = treeFiles(dir, buildTree(dir).tree);
    assert.ok(!files.includes('out/a.js'));
    assert.ok(!files.includes('README.md'));
  } finally { t.cleanup(); }
});
