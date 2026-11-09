# Airspace v1 design

Airspace lets every coding agent, and every person, on a small team see what everyone else is changing right now. That way two people's work doesn't collide and get discovered only at merge time.

Each working copy (a clone or a git worktree) runs one small background process. The process saves a snapshot of the work in progress, including uncommitted files, under a hidden git ref. It shares that snapshot through the team's normal git remote and fetches everyone else's. It then works out who would clash with whom and writes one state file. Agents (through Claude Code hooks), the `airspace status` command and a local web page all read that one file.

No server, no accounts and no npm dependencies. Node 20+ and git 2.38+ (for `git merge-tree --write-tree`).

## Words used here

- **Workstream.** One working copy and whoever is working in it, a person or an agent.
- **Snapshot.** A git commit made from the working copy without touching the branch, the index or the files.
- **Hidden ref.** A git ref outside `refs/heads/`, so it never shows up as a branch.

## Data shapes

The snapshot commit carries its metadata as JSON in the commit message. The tree is the filtered working copy. The parent is the base commit, described under Snapshot below.

```js
// Snapshot commit message
{ airspace: 1, id, name, email, branch, task, agent, updatedAt }

// Workstream: one per working copy, read back from a snapshot ref
{ id, name, email, branch, task, agent, updatedAt, files: string[], mine: boolean }
//   files = paths changed between the snapshot's parent (base) and the snapshot

// Clash: my workstream against one other
{ with: id, files: string[], conflicts: string[] }
//   files     = paths both of us changed
//   conflicts = paths where git's three-way merge reports a conflict (same lines)

// State: written only by the process, read by status, hooks and the GUI
{
  version: 1,
  generatedAt,                         // ISO time
  me: Workstream,
  others: Workstream[],                // fresh only (updated in the last 10 min)
  clashes: Clash[],
  notShared: [{ path, reason }],       // left out of my snapshot, and why
  daemon: { pid, port, lastSyncOk, lastError }
}
```

## Identity and refs

- `id` is `<user-slug>/<worktree-slug>`. The user slug comes from `git config user.name` or the email, as lowercase letters, digits and dashes. The worktree slug is the first 8 hex characters of sha1(hostname + absolute worktree path).
- My snapshot lives at `refs/airspace/<id>`, both locally and on the remote.
- Other people's snapshots are fetched into `refs/airspace-remote/*`. They are never fetched into `refs/airspace/*`, so a fetch can never overwrite my own newer local ref. Worktrees of one repo share `refs/airspace/*`, so they see each other instantly without the network.
- When the same id appears in both places, the newer `updatedAt` wins.

## Where files live

Everything local goes in `<absolute git dir>/airspace/`, found with `git rev-parse --absolute-git-dir`. That directory is per worktree, so worktrees never share it.

- `state.json`: the State. It is written to a temp file and renamed, so readers never see half a file.
- `daemon.json`: `{ pid, port, startedAt }`.
- `daemon.log`: one line per sync error.
- `task.txt`: the one-sentence task set by `airspace task`.
- `agent.json`: `{ lastSeen }`, written by hooks. `agent` is true when it was seen in the last 10 minutes.
- `sessions/<session_id>.json`: `{ warned: [path] }`, the per-session memory the edit hook uses.

## Modules

One module per body of knowledge, not per pipeline step.

| File | Owns |
|---|---|
| `index.js` | The CLI. It parses arguments, calls modules and prints. It holds no logic of its own. |
| `src/git.js` | `git(args, {cwd, env, input})` returns `{code, stdout, stderr}` and never throws on a non-zero exit. |
| `src/workspace.js` | Root, git dir, airspace dir, identity, ref names, the remote's default branch, and the base commit. |
| `src/secrets.js` | Pure functions that decide whether a path or its content must never leave the machine. |
| `src/snapshot.js` | Builds the snapshot commit and the `notShared` list. |
| `src/sync.js` | Pushes my ref, deletes it, and fetches others. |
| `src/peers.js` | Reads all snapshot refs into Workstreams, then computes Clashes. Uses `merge-tree`. |
| `src/state.js` | `buildState`, `writeState`, `readState`, and the pure formatters for status and show. |
| `src/daemon.js` | The loop. Watches files, publishes, syncs, writes state and serves the GUI. |
| `src/hooks.js` | Pure handlers, `(event input, state, session memory) → hook output`, plus a thin stdin/stdout shell. |
| `src/gui.html` | A single page that polls `/api/state`. |

## Snapshot

1. **Base.** The base is `merge-base(HEAD, origin/<default>)`. The default branch is `refs/remotes/origin/HEAD`, falling back to `origin/main` and then `origin/master`. With no remote default, the base is `HEAD`. Because the base is already on the remote, pushing a snapshot uploads one new commit plus the changed file contents. Your unpushed commits themselves (their messages and history) are never uploaded. The current contents of the files they changed are, because those are part of what you're working on, and they pass through the secret filter first.
2. **Tree.** Copy the index to a temp file, then run `GIT_INDEX_FILE=<temp> git add -A` and `git write-tree`. The real index and the working files are never touched. `.gitignore` is respected.
3. **Secret filter.** Every path that differs between the base and the tree is checked. A path that fails is put back to its base version, or dropped if it is new, using `git update-index` on the temp index before `write-tree`. The path is recorded in `notShared` with a reason. The rules are:
   - **Name:** `.env` and `.env.*` (but not `.env.example` or `.env.sample`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, and any name containing `secret`, `credential`, `creds` or `password`.
   - **Content** (text files only): `-----BEGIN … PRIVATE KEY-----`, AWS keys (`AKIA[0-9A-Z]{16}`), GitHub tokens (`gh[pousr]_…`), Slack tokens (`xox[abpr]-…`), `sk-` style API keys, and `(api[_-]?key|secret|token|passw(or)?d)\s*[:=]\s*['"]?[^\s'"]{8,}`.
   - **Size:** files over 1 MB.
   - **Escape hatch:** a `.airspaceignore` file in the repo root, with one glob per line, adds more paths that never leave the machine.
4. **Commit.** `git commit-tree <tree> -p <base> -m <json>`. Before pushing, update the local ref with `git update-ref`.

## Sync (the process loop)

- **Watch.** `fs.watch(root, { recursive: true })`, ignoring `.git/`. On a change, wait 1 s of quiet, then snapshot. If the tree is the same as the last published tree, skip the push.
- **Heartbeat.** Republish every 2 min even with no change, so `updatedAt` stays fresh. Others drop a workstream after 10 min without an update.
- **Fetch.** Every `AIRSPACE_INTERVAL_MS`, 10 s by default, run `git fetch origin +refs/airspace/*:refs/airspace-remote/*` with `--prune`. Then rebuild state and write it.
- **Errors.** A failed push or fetch (offline, say) is recorded in `daemon.lastError` and retried next tick. The loop never dies on a git error.
- **Stop.** `airspace stop` kills the process and deletes my ref locally and on the remote. Running it twice is fine.

## Peers and clashes

- Read every ref under `refs/airspace/` and `refs/airspace-remote/`, and parse the JSON message. Skip refs whose message doesn't parse. Drop stale ones (older than 10 min) and my own id.
- `files` is `git diff --name-only <parent> <snapshot>`.
- For each other workstream, `files` in the Clash is the intersection of their files and mine. When that is non-empty, run `git merge-tree --write-tree --name-only <mine> <theirs>`. The output is trusted only when its first line is a 40-character object id. The conflicted paths are the lines after it, up to the first blank line. Don't rely on the exit code alone, because git also exits 1 on errors like a missing ref.

## Hooks (Claude Code)

`airspace init` merges these into `.claude/settings.local.json`, adds that file to `.git/info/exclude`, and starts the process. Each command is `"<node path>" "<abs path>/index.js" hook <event>`. Running init twice must not duplicate entries.

| Event | Matcher | Does |
|---|---|---|
| `SessionStart` | (none) | Marks the agent as active. If others are active, it adds a short summary as `additionalContext` naming who, their task and their files. It always ends with one line telling the agent it can run `airspace task "<one sentence>"` to tell the team what it's doing, and `airspace status` for detail. |
| `UserPromptSubmit` | (none) | Marks the agent as active. If others are active, it adds the same short summary. Otherwise it adds nothing. |
| `PreToolUse` | `Edit\|Write\|MultiEdit\|NotebookEdit` | Marks the agent as active. If the target file (`tool_input.file_path` or `notebook_path`, made relative to the root) is in any other workstream's `files`, and this session hasn't been warned about that path yet, it denies once with `permissionDecision: "deny"` and a reason. The reason names who, their task, whether the same lines conflict, says that retrying the same edit will go through, and points to `airspace show <name>`. It then records the path in the session file. Otherwise it prints nothing and exits 0. |

Hooks fail open. If there's no state, stale state (over 60 s old) or any error, they print nothing and exit 0, except that `SessionStart` mentions that Airspace isn't running. A hook must never block an agent because Airspace is broken.

## CLI

```
airspace init                 set up hooks for this repo and start the process
airspace start | stop         start or stop the background process (both idempotent)
airspace status [--json]      who is working on what, and any clashes
airspace show <name> [--json] one person's workstreams in detail
airspace task "<sentence>"    set what this working copy is doing
airspace gui [--open]         print (or open) the local page's URL
airspace hook <event>         used by Claude Code hooks; reads JSON on stdin
```

`status` and `show` read `state.json`. If the process isn't running, they say so and how to start it.

## GUI

The process serves `http://127.0.0.1:<port>/` on a free port, bound to localhost only. `GET /` returns `gui.html` and `GET /api/state` returns the State. The page polls every 2 s. It shows me, every other workstream (name, task, branch, files, how long ago it updated, agent or person) and every clash. A conflict on the same lines is visually stronger than an overlap in the same file. It also shows what wasn't shared and why. It has a light and a dark theme, works at phone width, and has no external requests.

## Done means

Run on this Mac with a bare repo standing in for GitHub and two clones, `alice` and `bob`, each running `airspace init`:

1. Alice edits `auth.js` without committing. Within 15 s, `airspace status` in Bob's clone lists Alice's workstream with `auth.js`.
2. Bob edits the same lines without committing. Both clones report a conflict on `auth.js`.
3. A `creds.txt` containing a token, and a `.env`, never appear in Alice's published snapshot tree. `status` shows them under not shared.
4. In Bob's clone, a real `claude -p` session told to edit `auth.js` gets refused once with Alice's name in the reason, and the retry goes through.
5. `GET /api/state` returns the same data, and the page renders it.
6. `npm test` passes.
7. `airspace stop` removes Alice's ref from the remote.

Not covered in v1: real GitHub (not tested yet), agents other than Claude Code, and logical clashes across different files (only the task sentence hints at those).
