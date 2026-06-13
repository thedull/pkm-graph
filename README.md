# PKM Knowledge Graph — Setup & Usage

## Prerequisites
- Docker installed and running
- Python 3.11+
- Node.js 18+

## Quick start (one command)

From the vault root:
```bash
bash wiki/projects/pkm-evolution/graph/start.sh
```

That's it. The script:
1. Creates and starts the Neo4j Docker container (with GDS plugin)
2. Waits for Neo4j to be ready
3. Installs Python deps if needed
4. Syncs all 470+ vault notes → Neo4j
5. Installs npm deps if needed
6. Starts the viz server
7. Opens http://localhost:3000

Re-running is safe — it skips steps that are already done.

Or from Claude Code: `/graph-start`

## Stop everything
```bash
bash wiki/projects/pkm-evolution/graph/stop.sh
```

## Run GDS hidden-relationship discovery
After the stack is up:
```bash
python3 wiki/projects/pkm-evolution/graph/sync.py --vault . --discover-only
```
Or: `/graph-discover`

Writes a synthesis report to `wiki/synthesis/Graph Discovery Report YYYY-MM-DD.md`.

## Endpoints
- **3D graph viz** → http://localhost:3000
- **Neo4j Browser** → http://localhost:7474 (neo4j / neo4jpass)
- **Graph API** → http://localhost:3000/api/graph

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
graph/
├── start.sh             One-command startup (Docker + sync + viz)
├── stop.sh              Tear down stack
├── sync.py              Ingestion (vault → Neo4j) + GDS runner
├── requirements.txt     Python deps
├── cypher/              Reference Cypher queries (one per algorithm)
├── viz/
│   ├── server.js        Express API server
│   ├── index.html       3d-force-graph frontend
│   └── package.json
└── .sync-state.json     Mtime cache (gitignored)
```
