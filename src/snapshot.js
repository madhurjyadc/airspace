import fs from 'node:fs';
import path from 'node:path';
import { git } from './git.js';
import { pathReason, sizeReason, contentReason, parseIgnore } from './secrets.js';
import * as ws from './workspace.js';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbbf4904';
const ZERO = '0'.repeat(40);

function parseRaw(out) {
  const parts = out.split('\0');
  const entries = [];
  for (let i = 0; i + 1 < parts.length; i++) {
    if (!parts[i].startsWith(':')) continue;
    const [oldMode, newMode, oldOid, newOid, status] = parts[i].slice(1).split(' ');
    entries.push({ oldMode, newMode, oldOid, newOid, status: status[0], path: parts[++i] });
  }
  return entries;
}

function blobSizes(root, oids) {
  const r = git(['cat-file', '--batch-check'], { cwd: root, input: oids.join('\n') + '\n' });
  return r.stdout.trim().split('\n').map((l) => Number(l.split(' ')[2]));
}

// Builds the tree of the working copy minus anything secret, using a throwaway index.
// The real index, HEAD and working files are never touched.
export function buildTree(root) {
  const base = ws.baseCommit(root);
  const tmpIndex = path.join(ws.airspaceDir(root), `index.${process.pid}.tmp`);
  const realIndex = path.resolve(root, git(['rev-parse', '--git-path', 'index'], { cwd: root }).stdout.trim());
  if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmpIndex);
  const env = { GIT_INDEX_FILE: tmpIndex };
  const run = (args, input) => git(args, { cwd: root, env, input });
  try {
    const add = run(['add', '-A']);
    if (add.code !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`);
    const diff = run(['diff-index', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev', base ?? EMPTY_TREE]);
    const entries = parseRaw(diff.stdout).filter((e) => e.status !== 'D');
    const ignore = parseIgnore(ws.readIgnoreFile(root));
    const notShared = [];
    const revert = [];
    const toCheck = entries.filter((e) => e.newMode !== '160000');
    const sizes = toCheck.length ? blobSizes(root, toCheck.map((e) => e.newOid)) : [];
    toCheck.forEach((e, i) => {
      let reason = pathReason(e.path, ignore) ?? sizeReason(sizes[i]);
      if (!reason) reason = contentReason(Buffer.from(git(['cat-file', 'blob', e.newOid], { cwd: root }).stdout));
      if (!reason) return;
      notShared.push({ path: e.path, reason });
      revert.push(e.status === 'A' ? `0 ${ZERO}\t${e.path}\0` : `${e.oldMode} ${e.oldOid}\t${e.path}\0`);
    });
    if (revert.length) {
      const r = run(['update-index', '-z', '--index-info'], revert.join(''));
      if (r.code !== 0) throw new Error(`git update-index failed: ${r.stderr.trim()}`);
    }
    const wt = run(['write-tree']);
    if (wt.code !== 0) throw new Error(`git write-tree failed: ${wt.stderr.trim()}`);
    notShared.sort((a, b) => a.path.localeCompare(b.path));
    return { tree: wt.stdout.trim(), base, notShared };
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

export function currentBranch(root) {
  const r = git(['symbolic-ref', '--short', '--quiet', 'HEAD'], { cwd: root });
  return r.code === 0 ? r.stdout.trim() : 'HEAD';
}

// Commits the tree on top of the base and points my local ref at it.
export function commitSnapshot(root, { tree, base }, { task = '', agent = false, now = Date.now() } = {}) {
  const me = ws.identity(root);
  const meta = {
    airspace: 1, id: me.id, name: me.name, email: me.email,
    branch: currentBranch(root), task, agent, updatedAt: new Date(now).toISOString(),
  };
  const who = { GIT_AUTHOR_NAME: me.name, GIT_AUTHOR_EMAIL: me.email || 'airspace@localhost' };
  const env = { ...who, GIT_COMMITTER_NAME: who.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: who.GIT_AUTHOR_EMAIL };
  const args = ['commit-tree', tree, ...(base ? ['-p', base] : []), '-m', JSON.stringify(meta)];
  const c = git(args, { cwd: root, env });
  if (c.code !== 0) throw new Error(`git commit-tree failed: ${c.stderr.trim()}`);
  const commit = c.stdout.trim();
  const u = git(['update-ref', ws.ownRef(me.id), commit], { cwd: root });
  if (u.code !== 0) throw new Error(`git update-ref failed: ${u.stderr.trim()}`);
  return commit;
}
