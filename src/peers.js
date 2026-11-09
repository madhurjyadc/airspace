import { git } from './git.js';
import { EMPTY_TREE } from './snapshot.js';
import { OWN_PREFIX, REMOTE_PREFIX } from './workspace.js';

export const STALE_MS = 10 * 60 * 1000;

// Names, tasks and branches come from other machines and end up in an agent's context, so keep them short and one line.
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);

function parseSnapshot(line) {
  const [refname, oid, parent, subject] = line.split('\t');
  let m;
  try { m = JSON.parse(subject); } catch { return null; }
  if (!m || m.airspace !== 1 || typeof m.id !== 'string' || Number.isNaN(Date.parse(m.updatedAt))) return null;
  return {
    refname, oid, parent: (parent || '').split(' ')[0] || null,
    ws: {
      id: clean(m.id, 80), name: clean(m.name, 60), email: clean(m.email, 80), branch: clean(m.branch, 100),
      task: clean(m.task, 200), agent: m.agent === true, updatedAt: new Date(m.updatedAt).toISOString(),
    },
  };
}

function changedFiles(root, parent, oid) {
  const r = git(['diff', '--name-only', '-z', '--no-renames', parent ?? EMPTY_TREE, oid], { cwd: root });
  return r.code === 0 ? r.stdout.split('\0').filter(Boolean).sort() : null;
}

// Local and fetched refs can name the same workstream; the newer updatedAt wins, ties go to the local ref.
export function loadPeers(root, myId, now = Date.now()) {
  const list = git(['for-each-ref', '--format=%(refname)%09%(objectname)%09%(parent)%09%(contents:subject)', OWN_PREFIX, REMOTE_PREFIX], { cwd: root });
  const best = new Map();
  for (const line of list.stdout.split('\n').filter(Boolean)) {
    const s = parseSnapshot(line);
    if (!s) continue;
    const prev = best.get(s.ws.id);
    const newer = !prev || Date.parse(s.ws.updatedAt) > Date.parse(prev.ws.updatedAt);
    const tie = prev && s.ws.updatedAt === prev.ws.updatedAt && s.refname.startsWith(OWN_PREFIX);
    if (newer || tie) best.set(s.ws.id, s);
  }
  let mine = null;
  const others = [];
  for (const s of best.values()) {
    const files = changedFiles(root, s.parent, s.oid);
    if (!files) continue;
    const entry = { ws: { ...s.ws, files, mine: s.ws.id === myId }, oid: s.oid };
    if (s.ws.id === myId) mine = entry;
    else if (now - Date.parse(s.ws.updatedAt) <= STALE_MS) others.push(entry);
  }
  others.sort((a, b) => a.ws.id.localeCompare(b.ws.id));
  return { mine, others };
}

const OID = /^[0-9a-f]{40}$/;

// Exit codes are not enough: git also exits 1 on errors. Trust only output that starts with a tree id.
export function parseMergeTree(stdout) {
  const lines = stdout.split('\n');
  if (!OID.test(lines[0])) return null;
  const rest = lines.slice(1);
  const end = rest.indexOf('');
  return [...new Set(end === -1 ? rest : rest.slice(0, end))];
}

export function clashesFor(root, mine, others) {
  if (!mine) return [];
  const clashes = [];
  for (const o of others) {
    const theirs = new Set(o.ws.files);
    const files = mine.ws.files.filter((f) => theirs.has(f));
    if (!files.length) continue;
    const r = git(['merge-tree', '--write-tree', '--name-only', mine.oid, o.oid], { cwd: root });
    const conflicts = (parseMergeTree(r.stdout) ?? []).filter((f) => files.includes(f));
    clashes.push({ with: o.ws.id, files, conflicts });
  }
  return clashes;
}
