#!/bin/sh
set -eu
cd "$(dirname "$0")"
ISH_BUNDLED_NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
if [ -x "$ISH_BUNDLED_NODE" ]; then
  ISH_NODE="$ISH_BUNDLED_NODE"
elif command -v node >/dev/null 2>&1; then
  ISH_NODE="$(command -v node)"
else
  echo "Install Node 20.19+ or 22.12+, then run npm ci and ./start.sh."
  exit 1
fi
if [ ! -f node_modules/vite/bin/vite.js ]; then
  echo "Dependencies are missing. Run npm ci, then ./start.sh."
  exit 1
fi
exec "$ISH_NODE" node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort "$@"
