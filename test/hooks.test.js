import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTeam, sh } from '../testlib/repos.js';
import { handleHook, runHook, mergeSettings, hookConfig, installHooks, summary } from '../src/hooks.js';
import { writeState, readState } from '../src/state.js';
import { stopDaemon, runningDaemon } from '../src/daemon.js';
import { pidAlive, readDaemon } from '../src/workspace.js';

const INDEX = fileURLToPath(new URL('../index.js', import.meta.url));
const now = Date.parse('2026-11-08T12:00:00Z');
const iso = (offset = 0) => new Date(now + offset).toISOString();

const alice = { id: 'alice/aaaaaaaa', name: 'alice', email: '', branch: 'auth-fix', task: 'fix login', agent: true, updatedAt: iso(-5000), files: ['auth.js', 'lib/token.js'], mine: false };
const state = (extra = {}) => ({
  version: 1, generatedAt: iso(-3000),
  me: { ...alice, id: 'bob/bbbbbbbb', name: 'bob', files: [], mine: true }, others: [alice],
  clashes: [], notShared: [], daemon: {}, ...extra,
});
const edit = (file, extra = {}) => ({ session_id: 's1', cwd: '/repo', tool_name: 'Edit', tool_input: { file_path: file }, ...extra });
const ctx = (extra = {}) => ({ state: state(), root: '/repo', now, ...extra });

test('SessionStart summarizes others and always ends with the task hint', () => {
  const { output } = handleHook('SessionStart', {}, ctx());
  const h = output.hookSpecificOutput;
  assert.equal(h.hookEventName, 'SessionStart');
  assert.match(h.additionalContext, /1 other is changing/);
  assert.match(h.additionalContext, /alice \(agent, branch auth-fix, task: fix login\): auth\.js, lib\/token\.js/);
  assert.match(h.additionalContext, /airspace task "<one sentence>".*airspace status/);
  const alone = handleHook('SessionStart', {}, ctx({ state: state({ others: [] }) })).output.hookSpecificOutput.additionalContext;
  assert.doesNotMatch(alone, /changing this repo/);
  assert.match(alone, /airspace task/);
});

test('SessionStart says Airspace is not running when state is missing or stale; other events stay silent', () => {
  for (const s of [null, state({ generatedAt: iso(-61000) })]) {
    assert.match(handleHook('SessionStart', {}, ctx({ state: s })).output.hookSpecificOutput.additionalContext, /not running/);
    assert.equal(handleHook('UserPromptSubmit', {}, ctx({ state: s })).output, null);
    assert.equal(handleHook('PreToolUse', edit('/repo/auth.js'), ctx({ state: s })).output, null);
  }
});

test('UserPromptSubmit adds the summary only when others are active', () => {
  assert.match(handleHook('UserPromptSubmit', {}, ctx()).output.hookSpecificOutput.additionalContext, /alice/);
  assert.equal(handleHook('UserPromptSubmit', {}, ctx({ state: state({ others: [] }) })).output, null);
});

test('PreToolUse denies once per session and path, then lets the retry through', () => {
  const first = handleHook('PreToolUse', edit('/repo/auth.js'), ctx());
  const h = first.output.hookSpecificOutput;
  assert.equal(h.hookEventName, 'PreToolUse');
  assert.equal(h.permissionDecision, 'deny');
  assert.match(h.permissionDecisionReason, /alice \(task: fix login\) is also changing auth\.js/);
  assert.match(h.permissionDecisionReason, /Retry the same edit/);
  assert.match(h.permissionDecisionReason, /airspace show alice/);
  assert.deepEqual(first.session.warned, ['auth.js']);

  assert.equal(handleHook('PreToolUse', edit('/repo/auth.js'), ctx({ session: first.session })).output, null);
  const other = handleHook('PreToolUse', edit('/repo/lib/token.js'), ctx({ session: first.session }));
  assert.equal(other.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(other.session.warned, ['auth.js', 'lib/token.js']);
});

test('PreToolUse says whether the lines conflict', () => {
  const conflict = state({ clashes: [{ with: alice.id, files: ['auth.js'], conflicts: ['auth.js'] }] });
  assert.match(handleHook('PreToolUse', edit('/repo/auth.js'), ctx({ state: conflict })).output.hookSpecificOutput.permissionDecisionReason, /conflict on the same lines/);
  const overlap = state({ clashes: [{ with: alice.id, files: ['auth.js'], conflicts: [] }] });
  assert.match(handleHook('PreToolUse', edit('/repo/auth.js'), ctx({ state: overlap })).output.hookSpecificOutput.permissionDecisionReason, /not the same lines so far/);
});

test('PreToolUse allows files nobody else touched, outside paths, notebooks, and odd input', () => {
  assert.equal(handleHook('PreToolUse', edit('/repo/other.js'), ctx()).output, null);
  assert.equal(handleHook('PreToolUse', edit('/elsewhere/auth.js'), ctx()).output, null);
  assert.equal(handleHook('PreToolUse', { tool_input: {} }, ctx()).output, null);
  assert.equal(handleHook('PreToolUse', { cwd: '/repo', tool_input: { notebook_path: 'auth.js' } }, ctx()).output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(handleHook('Bogus', {}, ctx()).output, null);
});

test('hook text is short and never uses the long dash', () => {
  const many = state({ others: Array.from({ length: 7 }, (_, i) => ({ ...alice, id: `u${i}/x`, name: `u${i}`, files: Array.from({ length: 9 }, (_, j) => `f${j}.js`) })) });
  const text = summary(many);
  assert.ok(text.split('\n').length <= 6);
  assert.match(text, /\+3 more/);
  assert.doesNotMatch(JSON.stringify(handleHook('PreToolUse', edit('/repo/auth.js'), ctx()).output) + text, /[–—]/);
});

test('runHook reads real state and session files, and fails open on garbage', () => {
  const t = makeTeam(['bob']);
  try {
    const dir = t.clones.bob;
    const fresh = state({ generatedAt: new Date().toISOString() });
    writeState(dir, fresh);
    const run = (event, input) => runHook(event, typeof input === 'string' ? input : JSON.stringify(input), dir);
    const input = { session_id: 'sess/1', cwd: dir, tool_input: { file_path: path.join(dir, 'auth.js') } };
    const first = JSON.parse(run('PreToolUse', input));
    assert.equal(first.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(run('PreToolUse', input), '');
    assert.equal(JSON.parse(run('PreToolUse', { ...input, session_id: 'sess2' })).hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(fs.existsSync(path.join(dir, '.git', 'airspace', 'agent.json')), 'agent marked active');

    assert.equal(run('PreToolUse', 'not json {{'), '');
    assert.equal(run('PreToolUse', ''), '');
    assert.equal(run('PreToolUse', '42'), '');
    assert.equal(run('PreToolUse', { cwd: '/definitely/not/a/repo', tool_input: { file_path: '/x' } }), '');
    fs.writeFileSync(path.join(dir, '.git', 'airspace', 'state.json'), '{broken');
    assert.equal(run('PreToolUse', { ...input, session_id: 'sess3' }), '');
    assert.match(JSON.parse(run('SessionStart', { cwd: dir })).hookSpecificOutput.additionalContext, /not running/);
  } finally { t.cleanup(); }
});

test('mergeSettings keeps existing keys and never duplicates', () => {
  const cfg = hookConfig('/usr/bin/node', '/opt/airspace/index.js');
  const existing = {
    permissions: { allow: ['Bash(ls)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }], Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] },
  };
  const once = mergeSettings(existing, cfg);
  const twice = mergeSettings(once, cfg);
  assert.deepEqual(twice, once);
  assert.deepEqual(once.permissions, existing.permissions);
  assert.deepEqual(once.hooks.Stop, existing.hooks.Stop);
  assert.equal(once.hooks.PreToolUse.length, 2);
  assert.equal(once.hooks.PreToolUse[1].matcher, 'Edit|Write|MultiEdit|NotebookEdit');
  assert.equal(once.hooks.PreToolUse[1].hooks[0].command, '"/usr/bin/node" "/opt/airspace/index.js" hook PreToolUse');
  assert.equal(once.hooks.SessionStart[0].matcher, undefined);
  assert.equal(once.hooks.UserPromptSubmit.length, 1);
});

test('installHooks writes settings, excludes the file once, and refuses broken JSON', () => {
  const t = makeTeam(['bob']);
  try {
    const dir = t.clones.bob;
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ model: 'x' }));
    const file = installHooks(dir, '/n/node', '/a/index.js');
    installHooks(dir, '/n/node', '/a/index.js');
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(s.model, 'x');
    assert.equal(s.hooks.SessionStart.length, 1);
    const exclude = fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
    assert.equal(exclude.split('\n').filter((l) => l === '.claude/settings.local.json').length, 1);
    assert.equal(sh(dir, 'status', '--porcelain'), '');
    fs.writeFileSync(file, '{oops');
    assert.throws(() => installHooks(dir), /not valid JSON/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{oops');
  } finally { t.cleanup(); }
});

test('airspace init twice leaves one set of hooks and one process; the hook command works end to end', async () => {
  const t = makeTeam(['bob']);
  const dir = t.clones.bob;
  const run = (...args) => spawnSync(process.execPath, [INDEX, ...args], { cwd: dir, encoding: 'utf8' });
  try {
    assert.equal(run('init').status, 0);
    const second = run('init');
    assert.match(second.stdout, /already running/);
    const s = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'));
    assert.equal(s.hooks.PreToolUse.length, 1);
    assert.equal(s.hooks.SessionStart.length, 1);
    const cmd = s.hooks.SessionStart[0].hooks[0].command;
    const r = spawnSync(cmd, { shell: true, cwd: dir, input: JSON.stringify({ session_id: 'a', cwd: dir }), encoding: 'utf8' });
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /airspace task/);
    assert.ok(readState(dir));
  } finally {
    const pid = readDaemon(dir)?.pid;
    await stopDaemon(dir);
    if (pid && pidAlive(pid)) process.kill(pid, 'SIGKILL');
    assert.equal(runningDaemon(dir), null);
    t.cleanup();
  }
});
