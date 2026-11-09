import fs from 'node:fs';
import path from 'node:path';
import * as ws from './workspace.js';
import { loadPeers, clashesFor } from './peers.js';

export const STATE_STALE_MS = 60 * 1000;

export const statePath = (root) => path.join(ws.airspaceDir(root), 'state.json');

export function buildState(root, { notShared = [], daemon = {}, now = Date.now() } = {}) {
  const me = ws.identity(root);
  const { mine, others } = loadPeers(root, me.id, now);
  const self = mine?.ws ?? {
    id: me.id, name: me.name, email: me.email, branch: '', task: ws.readTask(root),
    agent: ws.agentActive(root, now), updatedAt: new Date(now).toISOString(), files: [], mine: true,
  };
  return {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    me: self,
    others: others.map((o) => o.ws),
    clashes: clashesFor(root, mine, others),
    notShared,
    daemon: { pid: daemon.pid ?? process.pid, port: daemon.port ?? null, lastSyncOk: daemon.lastSyncOk ?? null, lastError: daemon.lastError ?? null },
  };
}

// Temp file then rename, so readers never see half a file.
export function writeState(root, state) {
  const target = statePath(root);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, target);
}

export function readState(root) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(root), 'utf8'));
    return s?.version === 1 ? s : null;
  } catch {
    return null;
  }
}

export const stateAgeMs = (state, now = Date.now()) => now - Date.parse(state.generatedAt);

export function ago(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

const list = (files, max = 8) => (files.length <= max ? files.join(', ') : `${files.slice(0, max).join(', ')} (+${files.length - max} more)`);
const kind = (w) => (w.agent ? 'agent' : 'person');

function clashLine(state, c) {
  const other = state.others.find((o) => o.id === c.with);
  const who = other ? other.name : c.with;
  const overlap = c.files.filter((f) => !c.conflicts.includes(f));
  const out = [];
  if (c.conflicts.length) out.push(`  CONFLICT with ${who}: ${list(c.conflicts)} (you both changed the same lines)`);
  if (overlap.length) out.push(`  Overlap with ${who}: ${list(overlap)} (same file, different lines)`);
  return out;
}

export function formatStatus(state, now = Date.now()) {
  const out = [];
  const me = state.me;
  out.push(`You: ${me.name} on ${me.branch || 'no branch'}${me.task ? `, working on: ${me.task}` : ''}`);
  out.push(`  ${me.files.length ? `changed: ${list(me.files)}` : 'no changes yet'}`);
  out.push('');
  if (!state.others.length) {
    out.push('Nobody else is changing this repo right now.');
  } else {
    out.push(`Others working right now (${state.others.length}):`);
    for (const o of state.others) {
      out.push(`  ${o.name} (${kind(o)}) on ${o.branch}, updated ${ago(o.updatedAt, now)}`);
      if (o.task) out.push(`    task: ${o.task}`);
      out.push(`    ${o.files.length ? `changed: ${list(o.files)}` : 'no changes yet'}`);
    }
  }
  out.push('');
  if (state.clashes.length) {
    out.push('Clashes with your work:');
    for (const c of state.clashes) out.push(...clashLine(state, c));
  } else {
    out.push('No clashes with your work.');
  }
  if (state.notShared.length) {
    out.push('', 'Not shared (kept on this machine):');
    for (const n of state.notShared) out.push(`  ${n.path}: ${n.reason}`);
  }
  if (state.daemon.lastError) out.push('', `Last sync problem: ${state.daemon.lastError}`);
  return out.join('\n');
}

export function findPeople(state, query) {
  const q = query.toLowerCase();
  return state.others.filter((o) => o.name.toLowerCase() === q || o.id.split('/')[0] === q || o.name.toLowerCase().startsWith(q));
}

export function formatShow(state, query, now = Date.now()) {
  const found = findPeople(state, query);
  if (!found.length) {
    const names = [...new Set(state.others.map((o) => o.name))];
    return `Nobody called "${query}" is working right now.${names.length ? ` Active: ${names.join(', ')}.` : ''}`;
  }
  const blocks = found.map((o) => {
    const out = [
      `${o.name} (${kind(o)})`,
      `  branch: ${o.branch}`,
      `  task: ${o.task || 'not set'}`,
      `  updated: ${ago(o.updatedAt, now)}`,
      `  files (${o.files.length}):`,
      ...o.files.map((f) => `    ${f}`),
    ];
    const clash = state.clashes.find((c) => c.with === o.id);
    out.push(clash ? `  against your work:` : '  no clash with your work');
    if (clash) out.push(...clashLine(state, clash).map((l) => `  ${l}`));
    return out.join('\n');
  });
  return blocks.join('\n\n');
}

export function showJson(state, query) {
  const found = findPeople(state, query);
  return found.map((w) => ({ ...w, clash: state.clashes.find((c) => c.with === w.id) ?? null }));
}
