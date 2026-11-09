import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

export const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

export function tmpDir(prefix = 'airspace-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function write(dir, rel, text) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

export const lines = (n, mark = '') => Array.from({ length: n }, (_, i) => `line ${i + 1}${i === 4 ? mark : ''}`).join('\n') + '\n';

// A bare "remote" with one pushed commit on main, plus one clone per name.
export function makeTeam(names = ['alice', 'bob']) {
  const root = tmpDir();
  const remote = path.join(root, 'remote.git');
  sh(root, 'init', '--bare', '-b', 'main', remote);
  const seed = path.join(root, 'seed');
  sh(root, 'clone', remote, seed);
  sh(seed, 'config', 'user.name', 'seed');
  sh(seed, 'config', 'user.email', 'seed@example.com');
  write(seed, 'auth.js', lines(12));
  write(seed, 'util.js', lines(12));
  write(seed, 'README.md', 'hello\n');
  sh(seed, 'add', '-A');
  sh(seed, 'commit', '-m', 'seed');
  sh(seed, 'push', 'origin', 'main');
  const clones = {};
  for (const name of names) {
    const dir = path.join(root, name);
    sh(root, 'clone', remote, dir);
    sh(dir, 'config', 'user.name', name);
    sh(dir, 'config', 'user.email', `${name}@example.com`);
    clones[name] = dir;
  }
  return { root, remote, clones, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
