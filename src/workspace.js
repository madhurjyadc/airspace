import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './git.js';

export const OWN_PREFIX = 'refs/airspace/';
export const REMOTE_PREFIX = 'refs/airspace-remote/';
export const AGENT_WINDOW_MS = 10 * 60 * 1000;

export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function findRoot(cwd) {
  const r = git(['rev-parse', '--show-toplevel'], { cwd });
  return r.code === 0 ? r.stdout.trim() : null;
}

export function gitDir(root) {
  return git(['rev-parse', '--absolute-git-dir'], { cwd: root }).stdout.trim();
}

export function airspaceDir(root) {
  const gd = gitDir(root);
  if (!gd) throw new Error(`not a git repository: ${root}`);
  const dir = path.join(gd, 'airspace');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function identity(root) {
  const cfg = (k) => git(['config', k], { cwd: root }).stdout.trim();
  const name = cfg('user.name');
  const email = cfg('user.email');
  const user = slug(name) || slug(email.split('@')[0]) || 'unknown';
  const tree = createHash('sha1').update(os.hostname() + root).digest('hex').slice(0, 8);
  return { name: name || user, email, id: `${user}/${tree}` };
}

export const ownRef = (id) => OWN_PREFIX + id;

function commitOf(root, ref) {
  const r = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root });
  return r.code === 0 ? r.stdout.trim() : null;
}

export function headCommit(root) {
  return commitOf(root, 'HEAD');
}

export function defaultBranchRef(root) {
  const sym = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd: root });
  const candidates = [sym.code === 0 ? sym.stdout.trim() : null, 'refs/remotes/origin/main', 'refs/remotes/origin/master'];
  return candidates.find((ref) => ref && commitOf(root, ref)) ?? null;
}

// The base is already on the remote, so publishing a snapshot never uploads unpushed commits.
export function baseCommit(root) {
  const head = headCommit(root);
  if (!head) return null;
  const def = defaultBranchRef(root);
  if (!def) return head;
  const mb = git(['merge-base', 'HEAD', def], { cwd: root });
  return mb.code === 0 ? mb.stdout.trim() : head;
}

const file = (root, name) => path.join(airspaceDir(root), name);

export function readTask(root) {
  try {
    return fs.readFileSync(file(root, 'task.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}

export function writeTask(root, text) {
  fs.writeFileSync(file(root, 'task.txt'), text.trim() + '\n');
}

export function markAgent(root, now = Date.now()) {
  fs.writeFileSync(file(root, 'agent.json'), JSON.stringify({ lastSeen: now }));
}

export function agentActive(root, now = Date.now()) {
  try {
    const { lastSeen } = JSON.parse(fs.readFileSync(file(root, 'agent.json'), 'utf8'));
    return now - lastSeen < AGENT_WINDOW_MS;
  } catch {
    return false;
  }
}

export function readIgnoreFile(root) {
  try {
    return fs.readFileSync(path.join(root, '.airspaceignore'), 'utf8');
  } catch {
    return '';
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// daemon.json plus whether that process is still there; null when the process was never started.
export function readDaemon(root) {
  try {
    const info = JSON.parse(fs.readFileSync(file(root, 'daemon.json'), 'utf8'));
    return { ...info, alive: pidAlive(info.pid) };
  } catch {
    return null;
  }
}
