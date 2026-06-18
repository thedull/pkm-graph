#!/usr/bin/env bash
# start.sh — one command to spin up the PKM Knowledge Graph
# Usage: bash ~/Projects/Claude/pkm-graph/start.sh
# Run from vault root.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VAULT_ROOT="${VAULT_ROOT:-$(cd "$SCRIPT_DIR/../pkm" && pwd 2>/dev/null || true)}"
export VAULT_ROOT
if [ -z "$VAULT_ROOT" ]; then
  echo "ERROR: VAULT_ROOT is not set and default path '$SCRIPT_DIR/../pkm' does not exist."
  echo "       Set it with: export VAULT_ROOT=/path/to/your/vault"
  exit 1
fi
VIZ_DIR="$SCRIPT_DIR/viz"
BOLT="bolt://localhost:7687"
NEO4J_HTTP="http://localhost:7474"
# Port the viz server listens on — honor PORT from the env or viz/.env (default 3000),
# so start.sh checks/opens the same port server.js binds.
VIZ_PORT="${PORT:-$(grep -E '^PORT=' "$VIZ_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '[:space:]' || true)}"
VIZ_PORT="${VIZ_PORT:-3000}"
CONTAINER_NAME="pkm-graph"
EMBED_MODEL="${EMBED_MODEL:-nomic-embed-text}"
OLLAMA_HTTP="${OLLAMA_NATIVE_URL:-http://localhost:11434}"

log()  { echo "  $*"; }
ok()   { echo "✓ $*"; }
warn() { echo "⚠ $*"; }
step() { echo; echo "── $*"; }

# Auto-detect container runtime
if command -v docker &>/dev/null; then
  CTR=docker
elif command -v podman &>/dev/null; then
  CTR=podman
else
  echo "ERROR: neither docker nor podman found in PATH"
  exit 1
fi

echo "PKM Knowledge Graph — startup"
echo "Vault:   $VAULT_ROOT"
echo "Runtime: $CTR"

# ── 1. Neo4j ─────────────────────────────────────────────────────────────────
step "Neo4j"

if ! $CTR info > /dev/null 2>&1; then
  echo "ERROR: $CTR daemon is not running."
  case "$(uname -s)" in
    Darwin) echo "       Start Docker Desktop and try again." ;;
    Linux)  echo "       Run: sudo systemctl start docker" ;;
    *)      echo "       Start the $CTR daemon and try again." ;;
  esac
  exit 1
fi

if $CTR ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  # Container is running but may be stuck in a PID-file restart loop; clear it proactively.
  $CTR exec "$CONTAINER_NAME" rm -f /var/lib/neo4j/run/neo4j.pid > /dev/null 2>&1 || true
  ok "Container '$CONTAINER_NAME' already running"
elif $CTR ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  log "Starting existing container '$CONTAINER_NAME'..."
  $CTR start "$CONTAINER_NAME" > /dev/null
  ok "Container started"
else
  log "Creating and starting Neo4j container with GDS plugin..."
  $CTR run \
    --name "$CONTAINER_NAME" \
    --detach \
    --restart always \
    --publish 7474:7474 \
    --publish 7687:7687 \
    --env NEO4J_AUTH=neo4j/neo4jpass \
    --env NEO4J_PLUGINS='["graph-data-science"]' \
    --env NEO4J_dbms_security_procedures_unrestricted='gds.*' \
    --env NEO4J_dbms_security_procedures_allowlist='gds.*' \
    --volume "$HOME/.neo4j/pkm-graph/data:/data" \
    --volume "$HOME/.neo4j/pkm-graph/logs:/logs" \
    neo4j:5.14.0 > /dev/null
  ok "Container created and started"
fi

# Wait for Neo4j to be ready (up to 90s — GDS download takes time on first run)
log "Waiting for Neo4j to be ready..."
MAX_WAIT=90
ELAPSED=0
until curl -sf "$NEO4J_HTTP" > /dev/null 2>&1; do
  if [ $ELAPSED -ge $MAX_WAIT ]; then
    echo
    echo "ERROR: Neo4j did not become ready within ${MAX_WAIT}s."
    echo "Check logs with: $CTR logs $CONTAINER_NAME"
    exit 1
  fi
  printf "."
  sleep 3
  ELAPSED=$((ELAPSED + 3))
done
echo
ok "Neo4j ready at $NEO4J_HTTP"

# ── 2. Python deps ────────────────────────────────────────────────────────────
step "Python dependencies"

VENV_DIR="$SCRIPT_DIR/.venv"
if [ ! -d "$VENV_DIR" ]; then
  log "Creating virtual environment..."
  python3 -m venv "$VENV_DIR"
fi
PYTHON="$VENV_DIR/bin/python3"
PIP="$VENV_DIR/bin/pip"

if "$PYTHON" -c "import frontmatter, neo4j" 2>/dev/null; then
  ok "Already installed"
else
  log "Installing into venv..."
  "$PIP" install -q -r "$SCRIPT_DIR/requirements.txt"
  ok "Installed"
fi

# ── 3. Embedding model (for Copilot semantic search) ─────────────────────────
step "Embedding model"

if command -v ollama &>/dev/null; then
  if ollama list 2>/dev/null | grep -q "^${EMBED_MODEL}"; then
    ok "Embedding model '${EMBED_MODEL}' already present"
  else
    log "Pulling embedding model '${EMBED_MODEL}' (one-time, ~274MB)..."
    if ollama pull "${EMBED_MODEL}" >/dev/null 2>&1; then
      ok "Embedding model ready"
    else
      warn "Could not pull '${EMBED_MODEL}' — semantic search will be skipped (Copilot still works)"
    fi
  fi
else
  warn "Ollama not found — skipping embeddings (Copilot semantic search disabled)"
fi

# ── 4. Sync vault → Neo4j (nodes, edges, embeddings) ─────────────────────────
step "Vault sync"

cd "$VAULT_ROOT"
"$PYTHON" "$SCRIPT_DIR/sync.py" \
  --vault . \
  --bolt "$BOLT" \
  --auth neo4j:neo4jpass

# ── 5. Graph analytics (communities, centrality, pathfinding projection) ─────
step "Graph analytics"

if "$PYTHON" "$SCRIPT_DIR/sync.py" --vault . --bolt "$BOLT" --auth neo4j:neo4jpass --gds; then
  ok "Communities, centrality & pathfinding ready"
else
  warn "Graph analytics step failed — the server will rebuild the projection on demand"
  warn "Re-run manually: $PYTHON $SCRIPT_DIR/sync.py --gds --bolt $BOLT --auth neo4j:neo4jpass"
fi

# ── 6. Viz config ─────────────────────────────────────────────────────────────
step "Viz config"

if [ ! -f "$VIZ_DIR/.env" ]; then
  log "Creating viz/.env from .env.example (edit it to add API keys)..."
  cp "$VIZ_DIR/.env.example" "$VIZ_DIR/.env"
  { grep -v '^VAULT_ROOT=' "$VIZ_DIR/.env"; printf 'VAULT_ROOT=%s\n' "$VAULT_ROOT"; } \
    > "$VIZ_DIR/.env.tmp" && mv "$VIZ_DIR/.env.tmp" "$VIZ_DIR/.env"
  ok "viz/.env created — edit it to configure AI providers"
else
  ok "viz/.env present"
fi
if ! grep -qE '^VAULT_ROOT=.+' "$VIZ_DIR/.env"; then
  warn "VAULT_ROOT not set in viz/.env — server will exit immediately. Set it to: $VAULT_ROOT"
fi

# ── 7. Viz server ─────────────────────────────────────────────────────────────
step "Visualization server"

if curl -sf "http://localhost:${VIZ_PORT}" > /dev/null 2>&1; then
  ok "Already running at http://localhost:${VIZ_PORT}"
else
  if [ ! -d "$VIZ_DIR/node_modules" ]; then
    log "Installing npm dependencies..."
    cd "$VIZ_DIR" && npm install --silent
    ok "npm install done"
  fi

  log "Starting viz server..."
  cd "$VIZ_DIR"
  nohup node server.js > "$SCRIPT_DIR/viz.log" 2>&1 &
  VIZ_PID=$!
  echo $VIZ_PID > "$SCRIPT_DIR/viz.pid"

  # Wait up to 10s for the server to respond
  ELAPSED=0
  until curl -sf "http://localhost:${VIZ_PORT}" > /dev/null 2>&1; do
    if [ $ELAPSED -ge 10 ]; then
      if kill -0 "$VIZ_PID" 2>/dev/null; then
        warn "Viz server (pid $VIZ_PID) is slow to start — check $SCRIPT_DIR/viz.log"
      else
        warn "Viz server crashed on startup — check $SCRIPT_DIR/viz.log"
        tail -n 5 "$SCRIPT_DIR/viz.log" | while IFS= read -r line; do echo "    $line"; done
      fi
      break
    fi
    sleep 1
    ELAPSED=$((ELAPSED + 1))
  done
  if curl -sf "http://localhost:${VIZ_PORT}" > /dev/null 2>&1; then
    ok "Viz server running (pid $VIZ_PID)"
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════"
echo "  Graph viz → http://localhost:${VIZ_PORT}"
echo "  Neo4j     → $NEO4J_HTTP"
echo "════════════════════════════════════"
echo

if command -v open > /dev/null 2>&1; then
  open "http://localhost:${VIZ_PORT}" 2>/dev/null || true
elif command -v xdg-open > /dev/null 2>&1; then
  xdg-open "http://localhost:${VIZ_PORT}" 2>/dev/null || true
fi
