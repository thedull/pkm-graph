# PKM Knowledge Graph

A 3D, interactive knowledge graph for a Markdown vault (Obsidian-compatible), with
Neo4j + Graph Data Science for community detection, centrality, and pathfinding — and
an AI **Copilot** that answers from your vault content and can drive the visualization.

## Prerequisites
- Docker (or Podman) installed and running
- Python 3.11+
- Node.js 18+
- A Markdown vault with YAML frontmatter, containing a `wiki/` folder
- **Optional** — [Ollama](https://ollama.com) running locally for the Copilot. `start.sh`
  auto-pulls the embedding model; everything else works without it.

## Quick start (one command, no manual steps)

```bash
git clone https://github.com/your-username/pkm-graph
cd pkm-graph
VAULT_ROOT=/path/to/your/vault bash start.sh
```

`VAULT_ROOT` must point to the directory that contains your `wiki/` folder. You can also
set it (and AI options) permanently in `viz/.env` — copy from `viz/.env.example`.

`start.sh` does everything end-to-end and is safe to re-run (it skips finished steps):
1. Starts the Neo4j container (with the GDS plugin) and waits for it
2. Sets up the Python venv + dependencies
3. Pulls the embedding model (`nomic-embed-text`) if Ollama is available
4. Syncs all vault notes → Neo4j **and embeds them** for semantic search
5. Runs graph analytics — communities (Leiden), centrality (betweenness/degree), and the
   pathfinding projection
6. Installs npm deps and starts the viz server
7. Opens the viz in your browser (default http://localhost:3000 — set `PORT` in `viz/.env`
   to change it; `start.sh` honors it automatically)

## Stop everything
```bash
bash stop.sh
```

## The Copilot

Open it with the **✦** button (top-right of the sidebar) or **Ask Copilot…** from any node
panel. It runs on a local model via Ollama (**Local**) or a cloud model via OpenRouter
(**Cloud**) — toggle in the header.

- **Grounded in your vault.** Each question retrieves the most relevant notes two ways —
  graph-grounded (the selected node, its neighbors and community) and **semantic** (vector
  search over note embeddings) — and answers from their actual content, citing titles.
- **Drives the graph.** Ask "find the path between Kant and Foucault" or "color by type"
  and it runs the real UI action (shown as a collapsible *Ran N tools* summary).
- **@-mention nodes.** Type `@` in the input to pin a specific note to the question.
- **Rich output.** Markdown, tables, and ```mermaid diagrams render inline.
- **Conversations.** Create / rename / switch / delete chats (＋ and ☰); persisted locally.

## How it's wired (data + retrieval)

- **Nodes/edges** are synced from Markdown frontmatter + wikilinks into Neo4j.
- **GDS** computes `community_id`, `betweenness`, `degree`, and an in-memory `vault`
  projection for Dijkstra pathfinding (the server rebuilds this projection on demand if
  Neo4j restarts).
- **Embeddings** (`nomic-embed-text`, 768-dim) are stored on each node as `text_embedding`
  and indexed by the Neo4j vector index `wikipage_embedding`. They live in the DB, never in
  the LLM prompt — they only improve retrieval precision.

## Excluding files (`.graphignore`)
Maintenance, generated, and dependency files shouldn't become graph nodes. List them in
`.graphignore` (gitignore-style — `#` comments, `*` globs, trailing `/` for directories,
`**/` for "any directory"). Patterns match note paths relative to the vault root:

```gitignore
**/node_modules/                  # dependency junk
wiki/projects/.../graph/          # an extracted sub-project
**/Graph Discovery Report*.md     # generated reports
wiki/artifacts/
ingest-queue.md
```

Ignored files are never ingested, and every `sync.py` run **prunes** nodes that are now
ignored *or* whose file no longer exists on disk (e.g. after moving files out) — so the
graph self-heals. Run it standalone with `--prune`.

## `sync.py` modes
```bash
python3 sync.py --vault "$VAULT_ROOT"                 # full sync (nodes, edges, embeddings, prune)
python3 sync.py --vault "$VAULT_ROOT" --prune         # remove .graphignore'd / missing nodes only
python3 sync.py --vault "$VAULT_ROOT" --gds           # (re)build communities/centrality + projection
python3 sync.py --vault "$VAULT_ROOT" --embed-only    # (re)embed all notes + vector index
python3 sync.py --vault "$VAULT_ROOT" --discover-only # GDS report → wiki/artifact/Graph Discovery Report …md
python3 sync.py --vault "$VAULT_ROOT" --no-embed      # full sync, skip embeddings
```

## Pathfinding samples (optional)
Copy `pathfinding.example.json` → `pathfinding.json` and add pairs of node titles from your
vault; the discovery report shows shortest paths between them. `pathfinding.json` is
gitignored so your vault content stays local.

## Endpoints
Viz/API run on `PORT` (default `3000`; set in `viz/.env`).
- **3D graph viz** → http://localhost:3000
- **Graph API** → http://localhost:3000/api/graph
- **Semantic search** → http://localhost:3000/api/semantic-search?q=…&k=5
- **Neo4j Browser** → http://localhost:7474 (neo4j / neo4jpass)

## Tests
```bash
cd viz && npx playwright test          # or: PORT=3100 npx playwright test
```

## Manual Docker (if needed)
```bash
docker run \
  --name pkm-graph --restart always \
  --publish 7474:7474 --publish 7687:7687 \
  --env NEO4J_AUTH=neo4j/neo4jpass \
  --env NEO4J_PLUGINS='["graph-data-science"]' \
  --env NEO4J_dbms_security_procedures_unrestricted='gds.*' \
  --env NEO4J_dbms_security_procedures_allowlist='gds.*' \
  --volume "$HOME/.neo4j/pkm-graph/data:/data" \
  --volume "$HOME/.neo4j/pkm-graph/logs:/logs" \
  neo4j:5.14.0
```

## File overview
```
pkm-graph/
├── start.sh                   Seamless one-command startup
├── stop.sh                    Tear down stack
├── sync.py                    Ingestion + GDS + embeddings (modes above)
├── requirements.txt           Python deps
├── pathfinding.example.json   Template for pathfinding pairs (copy → pathfinding.json)
├── cypher/                    Reference Cypher queries (one per algorithm)
├── viz/
│   ├── server.js              Express API (graph, path, note, chat, semantic-search)
│   ├── index.html             3d-force-graph frontend + Copilot
│   ├── tests/                 Playwright e2e tests
│   ├── package.json
│   └── .env.example           Copy to .env (VAULT_ROOT, AI providers, embed model)
└── .sync-state.json           Mtime cache (gitignored)
```
