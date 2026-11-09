import { git } from './git.js';
import { OWN_PREFIX, REMOTE_PREFIX, ownRef } from './workspace.js';

const NET_TIMEOUT_MS = 30000;
const result = (r) => (r.code === 0 ? { ok: true } : { ok: false, error: r.stderr.trim() || `git exited ${r.code}` });

export function publish(root, id) {
  const ref = ownRef(id);
  return result(git(['push', '--no-verify', '--quiet', 'origin', `+${ref}:${ref}`], { cwd: root, timeout: NET_TIMEOUT_MS }));
}

// Others land in refs/airspace-remote so a fetch can never overwrite my own newer local ref.
export function fetchPeers(root) {
  const spec = `+${OWN_PREFIX}*:${REMOTE_PREFIX}*`;
  return result(git(['fetch', '--prune', '--no-tags', '--quiet', 'origin', spec], { cwd: root, timeout: NET_TIMEOUT_MS }));
}

// Safe to run twice: a ref that is already gone counts as removed.
export function removeOwn(root, id) {
  const ref = ownRef(id);
  git(['update-ref', '-d', ref], { cwd: root });
  const r = git(['push', '--no-verify', '--quiet', 'origin', '--delete', ref], { cwd: root, timeout: NET_TIMEOUT_MS });
  if (r.code !== 0 && /does not exist|unable to delete/.test(r.stderr)) return { ok: true };
  return result(r);
}
