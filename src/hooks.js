import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './git.js';
import * as ws from './workspace.js';
import { readState, STATE_STALE_MS } from './state.js';

export const EDIT_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
const TAIL = 'You can tell the team what you are doing with: airspace task "<one sentence>". Run "airspace status" for detail.';
const MAX_PEOPLE = 4;
const MAX_FILES = 4;

const isFresh = (state, now) => Boolean(state) && now - Date.parse(state.generatedAt) <= STATE_STALE_MS;
const more = (files) => files.slice(0, MAX_FILES).join(', ') + (files.length > MAX_FILES ? ` (+${files.length - MAX_FILES} more)` : '');
const context = (hookEventName, additionalContext) => ({ hookSpecificOutput: { hookEventName, additionalContext } });

export function summary(state) {
  const lines = [`Airspace: ${state.others.length} other${state.others.length === 1 ? ' is' : 's are'} changing this repo right now.`];
  for (const o of state.others.slice(0, MAX_PEOPLE)) {
    const clash = state.clashes.find((c) => c.with === o.id);
    const flag = clash?.conflicts.length ? ` CONFLICT with your work on ${more(clash.conflicts)}.` : clash ? ` Overlaps your files: ${more(clash.files)}.` : '';
    const task = o.task ? `, task: ${o.task}` : '';
    lines.push(`- ${o.name} (${o.agent ? 'agent' : 'person'}, branch ${o.branch}${task}): ${o.files.length ? more(o.files) : 'no files yet'}.${flag}`);
  }
  if (state.others.length > MAX_PEOPLE) lines.push(`(+${state.others.length - MAX_PEOPLE} more, see "airspace status")`);
  return lines.join('\n');
}

function denyReason(state, rel, who) {
  const parts = who.map((o) => {
    const clash = state.clashes.find((c) => c.with === o.id);
    const task = o.task ? ` (task: ${o.task})` : '';
    const how = clash?.conflicts.includes(rel) ? 'Your work and theirs conflict on the same lines.'
      : clash?.files.includes(rel) ? 'You both changed this file, not the same lines so far.'
      : 'They have uncommitted changes there.';
    return `${o.name}${task} is also changing ${rel}. ${how}`;
  });
  return `Airspace: ${parts.join(' ')} Retry the same edit and it will go through. Run "airspace show ${who[0].name}" for detail.`;
}

// Pure: (event input, state, session memory) in, hook output (or null) and the new session memory out.
export function handleHook(event, input, { state, session = { warned: [] }, root, now = Date.now() }) {
  const fresh = isFresh(state, now);
  if (event === 'SessionStart') {
    const text = fresh ? [state.others.length ? summary(state) : null, TAIL].filter(Boolean).join('\n')
      : 'Airspace is not running here. Start it with: airspace start';
    return { output: context('SessionStart', text), session };
  }
  if (event === 'UserPromptSubmit') {
    return { output: fresh && state.others.length ? context('UserPromptSubmit', summary(state)) : null, session };
  }
  if (event === 'PreToolUse' && fresh) {
    const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (typeof target !== 'string') return { output: null, session };
    const rel = path.relative(root, path.resolve(input.cwd ?? root, target)).split(path.sep).join('/');
    const who = state.others.filter((o) => o.files.includes(rel));
    if (rel.startsWith('..') || !who.length || session.warned.includes(rel)) return { output: null, session };
    return {
      output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyReason(state, rel, who) } },
      session: { warned: [...session.warned, rel] },
    };
  }
  return { output: null, session };
}

const safeName = (id) => String(id || 'default').replace(/[^\w-]/g, '_');

function realish(p) {
  try { return fs.realpathSync(p); } catch {}
  try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch {}
  return p;
}

// The thin I/O shell. Any failure means "print nothing", so a broken Airspace never blocks an agent.
export function runHook(event, stdinText, cwd = process.cwd()) {
  try {
    const input = JSON.parse(stdinText);
    if (!input || typeof input !== 'object') return '';
    const root = ws.findRoot(input.cwd ?? cwd);
    if (!root) return '';
    ws.markAgent(root);
    const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (typeof target === 'string') {
      const abs = realish(path.resolve(input.cwd ?? root, target));
      input.tool_input = { ...input.tool_input, file_path: abs, notebook_path: undefined };
    }
    const sessionFile = path.join(ws.airspaceDir(root), 'sessions', `${safeName(input.session_id)}.json`);
    let session = { warned: [] };
    try { session = JSON.parse(fs.readFileSync(sessionFile, 'utf8')); } catch {}
    const result = handleHook(event, input, { state: readState(root), session, root });
    if (result.session !== session) {
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(sessionFile, JSON.stringify(result.session));
    }
    return result.output ? JSON.stringify(result.output) : '';
  } catch {
    return '';
  }
}

export function hookConfig(nodePath, indexPath) {
  const cmd = (event) => ({ type: 'command', command: `"${nodePath}" "${indexPath}" hook ${event}` });
  return {
    SessionStart: { hooks: [cmd('SessionStart')] },
    UserPromptSubmit: { hooks: [cmd('UserPromptSubmit')] },
    PreToolUse: { matcher: EDIT_MATCHER, hooks: [cmd('PreToolUse')] },
  };
}

// Keeps every existing key and entry; adds ours only when the exact command is not there yet.
export function mergeSettings(settings, config) {
  const out = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  for (const [event, entry] of Object.entries(config)) {
    const entries = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
    const have = entries.some((e) => e.hooks?.some((h) => h.command === entry.hooks[0].command));
    out.hooks[event] = have ? entries : [...entries, entry];
  }
  return out;
}

export function installHooks(root, nodePath = process.execPath, indexPath = fileURLToPath(new URL('../index.js', import.meta.url))) {
  const file = path.join(root, '.claude', 'settings.local.json');
  let settings = {};
  if (fs.existsSync(file)) {
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
      throw new Error(`${file} is not valid JSON. Fix it or move it aside, then run init again.`);
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(mergeSettings(settings, hookConfig(nodePath, indexPath)), null, 2) + '\n');

  const exclude = path.resolve(root, git(['rev-parse', '--git-path', 'info/exclude'], { cwd: root }).stdout.trim());
  const line = '.claude/settings.local.json';
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!current.split('\n').includes(line)) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, (current && !current.endsWith('\n') ? '\n' : '') + line + '\n');
  }
  return file;
}
