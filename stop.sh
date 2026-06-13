#!/usr/bin/env bash
# stop.sh — tear down the PKM Knowledge Graph stack
# Usage: bash wiki/projects/pkm-evolution/graph/stop.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/viz.pid"

# Auto-detect container runtime
if command -v docker &>/dev/null; then
  CTR=docker
elif command -v podman &>/dev/null; then
  CTR=podman
else
  CTR=docker  # will fail gracefully below if neither found
fi

echo "Stopping PKM Knowledge Graph..."

# Stop viz server
if [ -f "$PID_FILE" ]; then
  VIZ_PID=$(cat "$PID_FILE")
  if kill -0 "$VIZ_PID" 2>/dev/null; then
    kill "$VIZ_PID"
    echo "✓ Viz server stopped (pid $VIZ_PID)"
  fi
  rm -f "$PID_FILE"
else
  # fallback: kill by port
  PIDS=$(lsof -ti:3000 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    echo "$PIDS" | xargs kill 2>/dev/null || true
    echo "✓ Viz server stopped"
  fi
fi

# Stop Neo4j container (leave data intact)
if $CTR ps --format '{{.Names}}' 2>/dev/null | grep -q "^pkm-graph$"; then
  $CTR stop pkm-graph > /dev/null
  echo "✓ Neo4j container stopped (data preserved)"
else
  echo "  Neo4j container was not running"
fi

echo "Done."
