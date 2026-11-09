import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTeam, sh, write, lines } from '../testlib/repos.js';
import { buildTree, commitSnapshot } from '../src/snapshot.js';
import { publish, fetchPeers, removeOwn } from '../src/sync.js';
import { loadPeers, clashesFor, parseMergeTree, STALE_MS } from '../src/peers.js';
import { identity } from '../src/workspace.js';

function share(dir, opts) {
  const commit = commitSnapshot(dir, buildTree(dir), opts);
  const r = publish(dir, identity(dir).id);
  assert.deepEqual(r, { ok: true });
  return commit;
}

test('parseMergeTree trusts only output that starts with a tree id', () => {
  const oid = 'a'.repeat(40);
  assert.deepEqual(parseMergeTree(`${oid}\n`), []);
  assert.deepEqual(parseMergeTree(`${oid}\nauth.js\nutil.js\n\nAuto-merging auth.js\nCONFLICT (content)\n`), ['auth.js', 'util.js']);
  assert.equal(parseMergeTree('fatal: not something we can merge\n'), null);
  assert.equal(parseMergeTree(''), null);
  assert.equal(parseMergeTree(`${'g'.repeat(40)}\nauth.js`), null);
});

test('two clones see each other, with same-line conflicts and different-line overlaps', () => {
  const t = makeTeam(['alice', 'bob', 'carol']);
  try {
    const { alice, bob, carol } = t.clones;
    write(alice, 'auth.js', lines(12, ' alice'));
    write(alice, 'util.js', lines(12).replace('line 1\n', 'line 1 alice\n'));
    write(alice, 'only-alice.js', 'a\n');
    share(alice, { task: 'fix login', agent: true });

    write(bob, 'auth.js', lines(12, ' bob'));
    write(bob, 'util.js', lines(12).replace('line 12\n', 'line 12 bob\n'));
    share(bob, { task: 'tokens' });

    write(carol, 'README.md', 'carol\n');
    share(carol, {});

    assert.deepEqual(fetchPeers(alice), { ok: true });
    const a = identity(alice);
    const b = identity(bob);
    const { mine, others } = loadPeers(alice, a.id);

    assert.equal(mine.ws.mine, true);
    assert.deepEqual(mine.ws.files, ['auth.js', 'only-alice.js', 'util.js']);
    assert.deepEqual(others.map((o) => o.ws.name), ['bob', 'carol']);
    const bobWs = others[0].ws;
    assert.equal(bobWs.id, b.id);
    assert.equal(bobWs.task, 'tokens');
    assert.equal(bobWs.agent, false);
    assert.equal(bobWs.mine, false);
    assert.deepEqual(bobWs.files, ['auth.js', 'util.js']);

    const clashes = clashesFor(alice, mine, others);
    assert.deepEqual(clashes, [{ with: b.id, files: ['auth.js', 'util.js'], conflicts: ['auth.js'] }]);
  } finally { t.cleanup(); }
});

test('different files produce no clash', () => {
  const t = makeTeam(['alice', 'bob']);
  try {
    write(t.clones.alice, 'one.js', '1\n');
    share(t.clones.alice, {});
    write(t.clones.bob, 'two.js', '2\n');
    share(t.clones.bob, {});
    fetchPeers(t.clones.alice);
    const { mine, others } = loadPeers(t.clones.alice, identity(t.clones.alice).id);
    assert.equal(others.length, 1);
    assert.deepEqual(clashesFor(t.clones.alice, mine, others), []);
  } finally { t.cleanup(); }
});

test('a merge-tree failure yields a clash with no conflicts instead of a false alarm', () => {
  const t = makeTeam(['alice']);
  try {
    const mine = { ws: { files: ['a.js'] }, oid: 'f'.repeat(40) };
    const other = { ws: { id: 'x/y', files: ['a.js'] }, oid: 'e'.repeat(40) };
    assert.deepEqual(clashesFor(t.clones.alice, mine, [other]), [{ with: 'x/y', files: ['a.js'], conflicts: [] }]);
  } finally { t.cleanup(); }
});

test('stale workstreams and my own id are dropped; garbage refs are skipped', () => {
  const t = makeTeam(['alice', 'bob']);
  try {
    const { alice, bob } = t.clones;
    write(bob, 'b.js', 'b\n');
    share(bob, {});
    write(alice, 'a.js', 'a\n');
    share(alice, {});
    const junk = sh(alice, 'commit-tree', sh(alice, 'rev-parse', 'HEAD^{tree}'), '-m', 'not json');
    sh(alice, 'update-ref', 'refs/airspace/junk/00000000', junk);
    fetchPeers(alice);
    const a = identity(alice);
    assert.ok(sh(alice, 'for-each-ref', 'refs/airspace-remote/').includes(a.id), 'own ref is fetched back');
    const fresh = loadPeers(alice, a.id);
    assert.deepEqual(fresh.others.map((o) => o.ws.name), ['bob']);
    assert.equal(fresh.mine.ws.id, a.id);
    const later = loadPeers(alice, a.id, Date.now() + STALE_MS + 60000);
    assert.deepEqual(later.others, []);
  } finally { t.cleanup(); }
});

test('fetch never overwrites my newer local ref; the newer updatedAt wins', () => {
  const t = makeTeam(['alice']);
  try {
    const dir = t.clones.alice;
    const id = identity(dir).id;
    write(dir, 'a.js', '1\n');
    share(dir, { now: Date.now() - 60000 });
    write(dir, 'a.js', '2\n');
    write(dir, 'b.js', 'b\n');
    const newer = commitSnapshot(dir, buildTree(dir), {});
    fetchPeers(dir);
    assert.equal(sh(dir, 'rev-parse', `refs/airspace/${id}`), newer);
    assert.notEqual(sh(dir, 'rev-parse', `refs/airspace-remote/${id}`), newer);
    assert.equal(loadPeers(dir, id).mine.oid, newer);
  } finally { t.cleanup(); }
});

test('removeOwn deletes the ref locally and on the remote, and twice is fine', () => {
  const t = makeTeam(['alice', 'bob']);
  try {
    const dir = t.clones.alice;
    const id = identity(dir).id;
    write(dir, 'a.js', '1\n');
    share(dir, {});
    assert.match(sh(t.remote, 'for-each-ref', 'refs/airspace/'), /airspace/);
    assert.deepEqual(removeOwn(dir, id), { ok: true });
    assert.deepEqual(removeOwn(dir, id), { ok: true });
    assert.equal(sh(t.remote, 'for-each-ref', 'refs/airspace/'), '');
    assert.equal(sh(dir, 'for-each-ref', 'refs/airspace/'), '');
    fetchPeers(t.clones.bob);
    assert.equal(sh(t.clones.bob, 'for-each-ref', 'refs/airspace-remote/'), '');
  } finally { t.cleanup(); }
});

test('publish and fetch report errors instead of throwing when there is no remote', () => {
  const t = makeTeam(['alice']);
  try {
    sh(t.clones.alice, 'remote', 'remove', 'origin');
    assert.equal(publish(t.clones.alice, 'x/y').ok, false);
    assert.equal(fetchPeers(t.clones.alice).ok, false);
  } finally { t.cleanup(); }
});
