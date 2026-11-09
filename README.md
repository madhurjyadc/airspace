# Airspace

Airspace shows everyone on a small team, people and coding agents, what the others are changing right now, so clashes are caught before merge time.

Each working copy runs one small background process. It saves a snapshot of your work in progress (including uncommitted files) under a hidden git ref, shares it through your normal git remote, and fetches everyone else's. It then works out who clashes with whom. There is no server, no account and no npm dependency. You need Node 20+ and git 2.38+.

## Install

```
node /path/to/airspace/index.js init
```

Run it inside a git repo. Later you can `npm link` in the airspace folder to get a plain `airspace` command.

`init` adds Claude Code hooks to `.claude/settings.local.json` (that file is added to `.git/info/exclude`, so it is never committed) and starts the process. Running it twice is safe.

## Commands

```
airspace init                 set up hooks for this repo and start the process
airspace start | stop         start or stop the background process
airspace status [--json]      who is working on what, and any clashes
airspace show <name> [--json] one person's workstreams in detail
airspace task "<sentence>"    set what this working copy is doing
airspace gui [--open]         print (or open) the local page's URL
```

`stop` removes your snapshot from the remote. The process also checks the remote every 10 s (set `AIRSPACE_INTERVAL_MS` to change that) and refreshes your snapshot every 2 min, and others drop you after 10 min of silence.

## What Claude Code sees

At session start and on each prompt, the agent gets a short list of who else is active and in which files. Before an edit to a file someone else is changing, the edit is refused once with a reason naming them. Retrying the same edit goes through. If Airspace is broken or its state is over a minute old, hooks do nothing and never block the agent.

## What is shared

Shared: the content of your changed files, including uncommitted and new files, as one commit sitting on top of the last commit that is already on the remote's default branch. Your unpushed commits are not uploaded as commits, only their file contents. Your name, branch, task sentence and the time are shared too.

Never shared, and listed under "not shared" in `status` and the page:

- files named `.env` or `.env.*` (but `.env.example` and `.env.sample` are fine), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, and any name containing `secret`, `credential`, `creds` or `password`
- files whose content has a private key, an AWS key, a GitHub or Slack token, an `sk-` API key, or a `key/secret/token/password = value` line
- files over 1 MB
- anything matched by a `.airspaceignore` file in the repo root (one glob per line)
- anything in `.gitignore`

A changed file that fails these checks goes out as its last pushed version, or not at all if it is new. These checks are pattern matching. They are a safety net, not a guarantee, so add anything sensitive to `.airspaceignore`.

## Limits

- Only clashes in the same file are found. Logical clashes across different files are not, apart from the task sentence.
- Only Claude Code hooks exist so far. Other agents can still use `airspace status`.
- Tested against a local bare repo standing in for a remote, not against real GitHub. A host that refuses pushes to custom refs under `refs/airspace/` will not work.
- Git operations run one at a time in the process. A slow or hung network can delay the page for up to 30 s per operation.
- Anyone who can fetch from the remote can read the snapshots, so the remote's access rules are your access rules.
- Other people's names, tasks and branches are shown to your agent as text. They are cut to one short line, but treat them as untrusted.

## Tests

```
npm test
```

Runs one test file at a time and starts a few short-lived background processes, which each test stops.

## Checking it works

- `npm test` runs the unit and integration tests (about 20 s).
- `scripts/e2e.sh` builds a pretend team in a temp folder: a stand-in for GitHub plus two clones, `alice` and `bob`. It runs the real CLI through the design's "done means" checks and prints PASS or FAIL for each.
- `scripts/agent-e2e.sh` runs one short real Claude Code session in Bob's clone. It shows the edit being paused once with Alice's name, then going through on retry.
