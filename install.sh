#!/usr/bin/env bash
# Installs this MCP server for the current user, in every project.
# Run from anywhere:  ./install.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_HOME="${GDOCS_MCP_HOME:-$HOME/.config/gdocs-mcp}"

command -v node >/dev/null || { echo "node is required (v18+). Install it first."; exit 1; }
command -v claude >/dev/null || { echo "the 'claude' CLI is required."; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "node 18+ required, found $(node -v)."; exit 1; }

echo "==> Installing dependencies"
( cd "$DIR" && npm install --silent )

echo "==> Verifying the server starts"
( cd "$DIR" && node smoke.mjs >/dev/null 2>&1 ) \
  || { echo "server failed to start; run 'node smoke.mjs' in $DIR to see why"; exit 1; }

echo "==> Registering with Claude Code (user scope: all projects)"
claude mcp remove gdocs -s user >/dev/null 2>&1 || true
claude mcp add gdocs -s user -- node "$DIR/server.mjs"

mkdir -p "$CONFIG_HOME"

cat <<MSG

Installed. Two things left, both yours to do because they involve credentials:

  1. Put your Google OAuth client JSON (Desktop app type) at:
       $CONFIG_HOME/credentials.json
     See README.md for the Google Cloud Console steps.

  2. Authorise once:
       cd "$DIR" && npm run auth

Then restart Claude Code. Check it with: claude mcp list

MSG
