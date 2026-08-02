#!/usr/bin/env bash
# Copies the built plugin into an Obsidian vault.
#   ./install.sh [/path/to/vault]
set -euo pipefail

VAULT="${1:-${OBSIDIAN_VAULT:-}}"
if [[ -z "$VAULT" ]]; then
	echo "Usage: ./install.sh /path/to/vault   (or set OBSIDIAN_VAULT)" >&2
	exit 1
fi
PLUGIN_ID="google-calendar-agenda"
TARGET="$VAULT/.obsidian/plugins/$PLUGIN_ID"

if [[ ! -d "$VAULT/.obsidian" ]]; then
	echo "Not an Obsidian vault: $VAULT" >&2
	exit 1
fi

if [[ ! -f main.js ]]; then
	echo "main.js is missing — run 'npm run build' first." >&2
	exit 1
fi

mkdir -p "$TARGET"
cp main.js manifest.json styles.css "$TARGET/"

echo "Installed to $TARGET"
echo "Enable it under Settings → Community plugins, then add your OAuth credentials."
