#!/usr/bin/env bash
# manage-project.sh — Medusa PM project management CLI
# Used by the Medusa bot to create and update projects in the hub.
# This is a PM management tool — not implementation code.
#
# Usage:
#   ./scripts/manage-project.sh create --title "..." --summary "..." --content "..." [--priority P0|P1|P2|P3]
#   ./scripts/manage-project.sh update <project-id> --status done [--summary "..."] [--content "..."]
#   ./scripts/manage-project.sh add-task <project-id> --owner "Dev1" --task "..." [--status pending|in_progress|done]
#   ./scripts/manage-project.sh done-task <project-id> <task-id>
#   ./scripts/manage-project.sh list
#   ./scripts/manage-project.sh get <project-id>

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

# Load auth token from .env
if [[ -f "$ENV_FILE" ]]; then
  AUTH_TOKEN=$(grep '^AUTH_TOKEN=' "$ENV_FILE" | cut -d= -f2 | tr -d '"' | tr -d "'")
else
  AUTH_TOKEN="${AUTH_TOKEN:-}"
fi

PORT=$(grep '^PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d '"' | tr -d "'" || echo "3456")
BASE_URL="http://localhost:${PORT}/api"

if [[ -z "$AUTH_TOKEN" ]]; then
  echo "❌ AUTH_TOKEN not found in .env or environment" >&2
  exit 1
fi

# ── Helpers ───────────────────────────────────────────────────────────────────
api() {
  local method="$1"; shift
  local path="$1";   shift
  curl -s -X "$method" \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    "$BASE_URL$path" \
    "$@"
}

require_arg() {
  if [[ -z "${2:-}" ]]; then
    echo "❌ Missing required argument: $1" >&2
    exit 1
  fi
}

# ── Commands ──────────────────────────────────────────────────────────────────
COMMAND="${1:-help}"
shift || true

case "$COMMAND" in

  # ── list ────────────────────────────────────────────────────────────────────
  list)
    echo "📋 Projects:"
    api GET "/projects" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for p in data:
    status_icon = '✅' if p.get('status') == 'complete' else '🟢'
    priority = p.get('priority', '—')
    assignments = len(p.get('assignments', []))
    print(f\"{status_icon} [{priority}] {p['title']} ({p['id']}) — {assignments} tasks\")
"
    ;;

  # ── get ─────────────────────────────────────────────────────────────────────
  get)
    PROJECT_ID="${1:-}"
    require_arg "--id" "$PROJECT_ID"
    api GET "/projects/$PROJECT_ID" | python3 -c "
import json, sys
p = json.load(sys.stdin)
print(f\"Title:    {p['title']}\")
print(f\"ID:       {p['id']}\")
print(f\"Status:   {p.get('status')}\")
print(f\"Priority: {p.get('priority', '—')}\")
print(f\"Summary:  {p.get('summary')}\")
print()
print('Assignments:')
for a in p.get('assignments', []):
    icon = {'done': '✅', 'in_progress': '🔄', 'pending': '⏳'}.get(a.get('status'), '?')
    print(f\"  {icon} [{a['id']}] {a['task']} → {a.get('owner', 'Unassigned')} ({a.get('status')})\")
"
    ;;

  # ── create ───────────────────────────────────────────────────────────────────
  create)
    TITLE=""; SUMMARY=""; CONTENT=""; PRIORITY=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --title)    TITLE="$2";    shift 2 ;;
        --summary)  SUMMARY="$2";  shift 2 ;;
        --content)  CONTENT="$2";  shift 2 ;;
        --priority) PRIORITY="$2"; shift 2 ;;
        *) echo "❌ Unknown arg: $1" >&2; exit 1 ;;
      esac
    done
    require_arg "--title"   "$TITLE"
    require_arg "--summary" "$SUMMARY"
    require_arg "--content" "$CONTENT"

    BODY=$(python3 -c "
import json, sys
d = {'title': sys.argv[1], 'summary': sys.argv[2], 'content': sys.argv[3]}
if sys.argv[4]: d['priority'] = sys.argv[4]
print(json.dumps(d))
" "$TITLE" "$SUMMARY" "$CONTENT" "$PRIORITY")

    RESULT=$(api POST "/projects" -d "$BODY")
    PROJECT_ID=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
    echo "✅ Created project: $TITLE (id: $PROJECT_ID)"
    ;;

  # ── update ───────────────────────────────────────────────────────────────────
  update)
    PROJECT_ID="${1:-}"
    require_arg "project-id" "$PROJECT_ID"
    shift

    PATCH="{}"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --status)   PATCH=$(echo "$PATCH" | python3 -c "import json,sys; d=json.load(sys.stdin); d['status']='$2'; print(json.dumps(d))"); shift 2 ;;
        --summary)  PATCH=$(echo "$PATCH" | python3 -c "import json,sys; d=json.load(sys.stdin); d['summary']='$2'; print(json.dumps(d))"); shift 2 ;;
        --priority) PATCH=$(echo "$PATCH" | python3 -c "import json,sys; d=json.load(sys.stdin); d['priority']='$2'; print(json.dumps(d))"); shift 2 ;;
        --content)  PATCH=$(echo "$PATCH" | python3 -c "import json,sys; d=json.load(sys.stdin); d['content']='$2'; print(json.dumps(d))"); shift 2 ;;
        *) echo "❌ Unknown arg: $1" >&2; exit 1 ;;
      esac
    done

    api PATCH "/projects/$PROJECT_ID" -d "$PATCH" | python3 -c "
import json, sys
p = json.load(sys.stdin)
print(f\"✅ Updated: {p['title']} (status={p['status']})\")
"
    ;;

  # ── add-task ─────────────────────────────────────────────────────────────────
  add-task)
    PROJECT_ID="${1:-}"
    require_arg "project-id" "$PROJECT_ID"
    shift

    OWNER="Unassigned"; TASK=""; STATUS="pending"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --owner)  OWNER="$2";  shift 2 ;;
        --task)   TASK="$2";   shift 2 ;;
        --status) STATUS="$2"; shift 2 ;;
        *) echo "❌ Unknown arg: $1" >&2; exit 1 ;;
      esac
    done
    require_arg "--task" "$TASK"

    BODY=$(python3 -c "
import json, sys, uuid
d = {'assignments': [{'id': str(uuid.uuid4()), 'owner': sys.argv[1], 'task': sys.argv[2], 'status': sys.argv[3]}]}
print(json.dumps(d))
" "$OWNER" "$TASK" "$STATUS")

    # Fetch current project, merge assignment, then patch
    CURRENT=$(api GET "/projects/$PROJECT_ID")
    MERGED=$(echo "$CURRENT" | python3 -c "
import json, sys, uuid
p = json.load(sys.stdin)
new_task = json.loads('$BODY')['assignments'][0]
p['assignments'].append(new_task)
print(json.dumps({'assignments': p['assignments']}))
")
    api PATCH "/projects/$PROJECT_ID" -d "$MERGED" | python3 -c "
import json, sys
p = json.load(sys.stdin)
print(f\"✅ Task added to: {p['title']}\")
"
    ;;

  # ── done-task ────────────────────────────────────────────────────────────────
  done-task)
    PROJECT_ID="${1:-}"; TASK_ID="${2:-}"
    require_arg "project-id" "$PROJECT_ID"
    require_arg "task-id"    "$TASK_ID"

    CURRENT=$(api GET "/projects/$PROJECT_ID")
    MERGED=$(echo "$CURRENT" | python3 -c "
import json, sys
p = json.load(sys.stdin)
for a in p['assignments']:
    if a['id'] == '$TASK_ID':
        a['status'] = 'done'
print(json.dumps({'assignments': p['assignments']}))
")
    api PATCH "/projects/$PROJECT_ID" -d "$MERGED" | python3 -c "
import json, sys
p = json.load(sys.stdin)
done = sum(1 for a in p['assignments'] if a['status'] == 'done')
total = len(p['assignments'])
print(f\"✅ Task marked done. Progress: {done}/{total} tasks complete.\")
if done == total:
    print('🎉 All tasks done! Consider marking project complete.')
"
    ;;

  # ── help ─────────────────────────────────────────────────────────────────────
  help|*)
    cat <<'HELP'
Medusa Project Management CLI
Usage:
  manage-project.sh list
  manage-project.sh get <project-id>
  manage-project.sh create --title "..." --summary "..." --content "..." [--priority P0|P1|P2|P3]
  manage-project.sh update <project-id> [--status active|complete] [--summary "..."] [--priority P0|P1|P2|P3]
  manage-project.sh add-task <project-id> --task "..." [--owner "Dev1"] [--status pending|in_progress|done]
  manage-project.sh done-task <project-id> <task-id>
HELP
    ;;

esac
