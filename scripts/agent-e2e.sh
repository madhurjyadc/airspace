#!/bin/bash
# Done-means 4: a real Claude Code session in Bob's clone is refused once on auth.js with
# Alice's name in the reason, then its retry goes through.
# Usage: scripts/agent-e2e.sh   (needs the claude CLI; runs one short Sonnet session)
set -u
APP=$(cd "$(dirname "$0")/.." && pwd)
AIR="node $APP/index.js"
W=$(mktemp -d)/team; V=$(dirname "$W")
export AIRSPACE_INTERVAL_MS=1000
cleanup() { (cd "$W/alice" 2>/dev/null && $AIR stop >/dev/null 2>&1); (cd "$W/bob" 2>/dev/null && $AIR stop >/dev/null 2>&1); }
trap cleanup EXIT

mkdir -p "$W"; cd "$W"
git init -q --bare -b main github.git
git clone -q github.git seed 2>/dev/null
( cd seed && git config user.name seed && git config user.email seed@example.com && git switch -qc main 2>/dev/null
  printf 'function login() {\n  return storeInCookie();\n}\n' > auth.js
  git add . && git commit -qm base && git push -q origin main )
for u in alice bob; do git clone -q github.git $u; git -C $u config user.name $u; git -C $u config user.email $u@example.com; done
(cd alice && $AIR init >/dev/null && $AIR task "rewriting login storage" >/dev/null)
(cd bob && $AIR init >/dev/null)
printf 'function login() {\n  return storeInDatabase();\n}\n' > alice/auth.js

for _ in $(seq 1 20); do (cd bob && $AIR status --json 2>/dev/null) | grep -q '"auth.js"' && break; sleep 1; done
echo "--- bob's status before the agent runs:"; (cd bob && $AIR status)
echo "--- bob's hook settings:"; cat bob/.claude/settings.local.json

cd bob
claude -p "Edit auth.js so that login() returns storeInMemory() instead of what it returns now. Just make the edit, then reply with one short sentence saying what you did and anything you noticed." \
  --model sonnet --permission-mode acceptEdits --max-turns 8 \
  --output-format stream-json --verbose > "$V/hook-run.jsonl" 2> "$V/hook-run.err"
echo "claude exit=$?"
echo "--- tool calls and hook messages:"
node -e '
const lines=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);
for (const l of lines){ let m; try{m=JSON.parse(l)}catch{continue}
  const c=m.message?.content; if(!Array.isArray(c)) { if(m.type==="result") console.log("RESULT:", m.result); continue }
  for (const b of c){
    if(b.type==="tool_use") console.log("TOOL_USE", b.name, JSON.stringify(b.input).slice(0,160));
    if(b.type==="tool_result") console.log("TOOL_RESULT", (typeof b.content==="string"?b.content:JSON.stringify(b.content)).slice(0,400));
  }}' "$V/hook-run.jsonl"
echo "--- auth.js in bob after the run:"; cat auth.js
echo "--- session memory:"; ls "$(git rev-parse --absolute-git-dir)/airspace/sessions/" 2>/dev/null && cat "$(git rev-parse --absolute-git-dir)"/airspace/sessions/*.json 2>/dev/null
