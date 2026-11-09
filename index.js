#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { findRoot, readTask, writeTask } from './src/workspace.js';
import { installHooks, runHook } from './src/hooks.js';
import { runningDaemon, startDaemon, stopDaemon } from './src/daemon.js';
import { readState, formatStatus, formatShow, showJson, stateAgeMs, STATE_STALE_MS, ago } from './src/state.js';

const HELP = `airspace: see what your team is changing right now

  airspace init                 set up hooks for this repo and start the process
  airspace start | stop         start or stop the background process
  airspace status [--json]      who is working on what, and any clashes
  airspace show <name> [--json] one person's workstreams in detail
  airspace task "<sentence>"    set what this working copy is doing
  airspace gui [--open]         print (or open) the local page's URL`;

const NOT_RUNNING = 'Airspace is not running in this repo. Start it with: airspace start';

function parse(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  return { flags, args: argv.filter((a) => !a.startsWith('--')) };
}

function repoRoot() {
  const root = findRoot(process.cwd());
  if (!root) {
    console.error('This is not inside a git repository.');
    process.exit(1);
  }
  return root;
}

function liveState(root) {
  if (!runningDaemon(root)) return { error: NOT_RUNNING };
  const state = readState(root);
  if (!state) return { error: 'Airspace is starting up. Try again in a few seconds.' };
  return { state };
}

function fail(json, message) {
  if (json) console.log(JSON.stringify({ error: message }));
  else console.error(message);
  process.exit(1);
}

const commands = {
  async init() {
    const root = repoRoot();
    const file = installHooks(root);
    console.log(`Hooks written to ${file}`);
    await commands.start();
  },

  async hook({ args }) {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    const out = runHook(args[0], text);
    if (out) process.stdout.write(out + '\n');
  },

  async start() {
    const { started, info } = await startDaemon(repoRoot());
    if (!info) return fail(false, 'Airspace did not start. See .git/airspace/daemon.log');
    console.log(started ? `Airspace started (page: http://127.0.0.1:${info.port}/)` : `Airspace is already running (page: http://127.0.0.1:${info.port}/)`);
  },

  async stop() {
    const { wasRunning, removed } = await stopDaemon(repoRoot());
    console.log(wasRunning ? 'Airspace stopped.' : 'Airspace was not running.');
    if (!removed.ok) console.error(`Could not remove your snapshot from the remote: ${removed.error}`);
  },

  async status({ flags }) {
    const root = repoRoot();
    const { state, error } = liveState(root);
    if (error) return fail(flags.has('--json'), error);
    if (flags.has('--json')) return console.log(JSON.stringify(state, null, 2));
    console.log(formatStatus(state));
    if (stateAgeMs(state) > STATE_STALE_MS) {
      console.log(`\nNote: this was last updated ${ago(state.generatedAt)}. The process may be stuck; see .git/airspace/daemon.log`);
    }
  },

  async show({ flags, args }) {
    const root = repoRoot();
    if (!args[0]) return fail(false, 'Usage: airspace show <name>');
    const { state, error } = liveState(root);
    if (error) return fail(flags.has('--json'), error);
    console.log(flags.has('--json') ? JSON.stringify(showJson(state, args[0]), null, 2) : formatShow(state, args[0]));
  },

  async task({ args }) {
    const root = repoRoot();
    if (!args.length) return console.log(readTask(root) || 'No task set. Usage: airspace task "<one sentence>"');
    writeTask(root, args.join(' '));
    console.log(`Task set: ${readTask(root)}`);
  },

  async gui({ flags }) {
    const root = repoRoot();
    const daemon = runningDaemon(root);
    if (!daemon) return fail(false, NOT_RUNNING);
    const url = `http://127.0.0.1:${daemon.port}/`;
    console.log(url);
    if (flags.has('--open')) {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
    }
  },
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP);
  if (!commands[cmd]) return fail(false, `Unknown command: ${cmd}\n\n${HELP}`);
  await commands[cmd](parse(rest));
}

main().catch((e) => fail(false, `airspace: ${e.message}`));
