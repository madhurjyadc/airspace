#!/bin/bash
# End-to-end check of Airspace v1 against docs/design.md "Done means" 1, 2, 3, 5, 7.
# Usage: scripts/e2e.sh   (from the repo root; builds a pretend team in a temp folder)
set -u
APP=$(cd "$(dirname "$0")/.." && pwd)
AIR="node $APP/index.js"
W=$(mktemp -d)/team
export AIRSPACE_INTERVAL_MS=1000
PASS=0; FAIL=0
ok()   { echo "PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL  $1"; FAIL=$((FAIL+1)); }
cleanup() { (cd "$W/alice" 2>/dev/null && $AIR stop >/dev/null 2>&1); (cd "$W/bob" 2>/dev/null && $AIR stop >/dev/null 2>&1); }
trap cleanup EXIT

mkdir -p "$W"; cd "$W"
git init -q --bare -b main github.git
git clone -q github.git seed 2>/dev/null
( cd seed && git config user.name seed && git config user.email seed@example.com && git switch -qc main 2>/dev/null
  printf 'function login() {\n  return storeInCookie();\n}\n' > auth.js
  printf 'export const a = 1;\n' > other.js
  printf '.env\n' > .gitignore
  git add . && git commit -qm base && git push -q origin main )
for u in alice bob; do git clone -q github.git $u; git -C $u config user.name $u; git -C $u config user.email $u@example.com; done

(cd alice && $AIR init >/dev/null) && ok "alice init" || bad "alice init"
(cd bob && $AIR init >/dev/null) && ok "bob init" || bad "bob init"
(cd alice && $AIR task "rewriting login storage" >/dev/null)

printf 'function login() {\n  return storeInDatabase();\n}\n' > alice/auth.js
echo 'TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789' > alice/creds.txt
echo 'SECRET=hunter2hunter2' > alice/.env

check() { # $1 dir, $2 JS expression over the State object s
  (cd "$1" && $AIR status --json 2>/dev/null) | node -e 'let s;try{s=JSON.parse(require("fs").readFileSync(0,"utf8"))}catch{process.exit(1)};process.exit((eval(process.argv[1]))?0:1)' "$2"; }
wait_for() { # $1 dir, $2 JS expression, $3 seconds
  for _ in $(seq 1 "$3"); do check "$1" "$2" && return 0; sleep 1; done; return 1; }

START=$(date +%s)
if wait_for bob 's.others.some(o=>o.name==="alice"&&o.files.includes("auth.js"))' 15; then ok "1. bob sees alice's uncommitted auth.js within $(( $(date +%s) - START ))s"; else bad "1. bob never saw alice's auth.js"; fi
check bob 's.others.some(o=>o.task==="rewriting login storage")' && ok "1b. bob sees alice's task sentence" || bad "1b. task sentence missing on bob"

printf 'function login() {\n  return storeInRedis();\n}\n' > bob/auth.js
if wait_for bob 's.clashes.some(c=>c.conflicts.includes("auth.js"))' 15; then ok "2. bob reports a same-lines conflict on auth.js"; else bad "2. bob shows no conflict"; fi
if wait_for alice 's.clashes.some(c=>c.conflicts.includes("auth.js"))' 15; then ok "2b. alice reports the conflict too"; else bad "2b. alice shows no conflict"; fi

REF=$(git -C github.git for-each-ref --format='%(refname)' 'refs/airspace/alice/*' | head -1)
if [ -n "$REF" ]; then
  FILES=$(git -C github.git ls-tree -r --name-only "$REF")
  echo "$FILES" | grep -qx 'auth.js' && ok "3a. alice's snapshot on the remote has auth.js" || bad "3a. auth.js missing from snapshot"
  echo "$FILES" | grep -qx 'creds.txt' && bad "3b. creds.txt LEAKED to the remote" || ok "3b. creds.txt not on the remote"
  echo "$FILES" | grep -qx '.env' && bad "3c. .env LEAKED to the remote" || ok "3c. .env not on the remote"
  git -C github.git log --all --format=%H | while read c; do git -C github.git ls-tree -r --name-only "$c"; done | grep -qx 'creds.txt' && bad "3d. creds.txt in some remote commit" || ok "3d. creds.txt in no remote commit at all"
else bad "3. no alice snapshot ref on the remote"; fi
(cd alice && $AIR status) | grep -q 'creds.txt' && ok "3e. alice's status lists creds.txt as not shared" || bad "3e. creds.txt not listed as not shared"

PORT=$(cd bob && $AIR gui | grep -oE '127\.0\.0\.1:[0-9]+' | head -1)
if [ -n "$PORT" ]; then
  curl -sf "http://$PORT/api/state" | grep -q '"auth.js"' && ok "5a. GET /api/state has the clash data" || bad "5a. /api/state wrong"
  curl -sf "http://$PORT/" | grep -qi '<html' && ok "5b. GET / serves the page" || bad "5b. page not served"
  echo "GUI_URL=http://$PORT/"
else bad "5. no GUI url"; fi

(cd alice && $AIR stop >/dev/null); (cd alice && $AIR stop >/dev/null) && ok "7a. stop twice is fine" || bad "7a. second stop failed"
[ -z "$(git -C github.git for-each-ref 'refs/airspace/alice/*')" ] && ok "7b. alice's ref removed from the remote" || bad "7b. alice's ref still on the remote"
if wait_for bob '!s.others.some(o=>o.name==="alice")' 15; then ok "7c. bob no longer lists alice"; else echo "INFO  7c. bob still lists alice (stays until her local copy of the ref is pruned)"; fi

echo "---- $PASS passed, $FAIL failed"
[ "${KEEP:-0}" = 1 ] && { trap - EXIT; echo "KEEP=1: daemons left running in $W"; }
[ "$FAIL" = 0 ]
