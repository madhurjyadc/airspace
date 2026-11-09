import { spawnSync } from 'node:child_process';

// Never throws on a non-zero exit; callers decide what a failure means.
export function git(args, { cwd, env, input, timeout } = {}) {
  const r = spawnSync('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    input,
    timeout,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr || (r.error ? r.error.message : ''),
  };
}
