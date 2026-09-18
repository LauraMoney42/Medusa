#!/usr/bin/env bash
# Store an API key for a Medusa provider in ~/.claude-chat/settings.json.
# Usage: bash scripts/set-provider-key.sh <provider-id>
# The key is read from the environment variable named for the provider
# (GEMINI_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, DEEPGRAM_API_KEY) or,
# if unset, prompted for silently. The key never appears on screen.
set -euo pipefail

PROVIDER="${1:-}"
if [ -z "$PROVIDER" ]; then
  echo "usage: bash scripts/set-provider-key.sh <gemini|openrouter|openai|deepgram>" >&2
  exit 1
fi

case "$PROVIDER" in
  gemini) VAR="GEMINI_API_KEY" ;;
  openrouter) VAR="OPENROUTER_API_KEY" ;;
  openai) VAR="OPENAI_API_KEY" ;;
  deepgram) VAR="DEEPGRAM_API_KEY" ;;
  *) VAR="$(echo "$PROVIDER" | tr '[:lower:]-' '[:upper:]_')_API_KEY" ;;
esac

KEY="${!VAR:-}"
if [ -z "$KEY" ]; then
  read -r -s -p "Paste the $PROVIDER API key (hidden): " KEY
  echo
fi
if [ -z "$KEY" ]; then
  echo "error: no key provided" >&2
  exit 1
fi

SETTINGS="$HOME/.claude-chat/settings.json"
mkdir -p "$(dirname "$SETTINGS")"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"

MEDUSA_KEY="$KEY" MEDUSA_PROVIDER="$PROVIDER" python3 - "$SETTINGS" <<'EOF'
import json, os, sys
path = sys.argv[1]
with open(path) as f:
    data = json.load(f)
providers = data.setdefault("providers", {})
entry = providers.setdefault(os.environ["MEDUSA_PROVIDER"], {})
entry["apiKey"] = os.environ["MEDUSA_KEY"]
with open(path, "w") as f:
    json.dump(data, f, indent=2)
os.chmod(path, 0o600)
print(f"saved {os.environ['MEDUSA_PROVIDER']} key (ends with ...{os.environ['MEDUSA_KEY'][-4:]}) to {path}")
EOF
echo "Restart Medusa (or toggle the mic off and on) to use it."
