require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const neo4j = require("neo4j-driver");
const { streamText } = require("ai");
const { createOpenAI } = require("@ai-sdk/openai");

const VAULT_ROOT = process.env.VAULT_ROOT;
if (!VAULT_ROOT) {
  console.error("ERROR: VAULT_ROOT env var is required. Set it in viz/.env or run via start.sh");
  process.exit(1);
}

function readNote(relPath) {
  const abs = path.join(VAULT_ROOT, relPath);
  if (!fs.existsSync(abs)) return null;
  const raw = fs.readFileSync(abs, "utf8");

  // strip YAML frontmatter
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  const body = fmMatch ? raw.slice(fmMatch[0].length).trim() : raw.trim();

  // parse a few useful fields from frontmatter
  let title = path.basename(relPath, ".md");
  let type = "unknown";
  if (fmMatch) {
    const fm = fmMatch[1];
    const tMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
    const tyMatch = fm.match(/^type:\s*(\S+)/m);
    if (tMatch) title = tMatch[1];
    if (tyMatch) type = tyMatch[1];
  }
  return { title, type, path: relPath, body };
}

// ─── AI provider factory ──────────────────────────────────────────────────────

function getAIProvider(provider, model) {
  if (provider === "openrouter") {
    const client = createOpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY || "",
    });
    return client(model || process.env.DEFAULT_OPENROUTER_MODEL || "mistralai/mistral-7b-instruct:free");
  }
  // Default: Ollama via OpenAI-compatible API
  const client = createOpenAI({
    baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
    apiKey: "ollama",
  });
  return client(model || process.env.DEFAULT_OLLAMA_MODEL || "llama3.2");
}

function buildSystemPrompt(ctx) {
  const stats = ctx.graphStats || {};
  const node = ctx.selectedNode;
  const pathStr = (ctx.currentPath || []).join(" → ");

  return `You are an AI research assistant embedded in a 3D knowledge graph visualization of a personal knowledge management (PKM) vault. The vault contains interconnected notes on philosophy, technology, and culture.

Graph overview:
- Total nodes: ${stats.nodes ?? "unknown"}
- Total edges: ${stats.edges ?? "unknown"}
- Communities (Leiden clustering): ${stats.communities ?? "unknown"}
- Current color mode: ${ctx.colorMode ?? "community"}
- Active node type filters: ${(ctx.activeFilters || []).join(", ") || "all types"}
- View mode: ${ctx.viewMode ?? "full graph"}
${node ? `
Currently selected node:
- Title: ${node.title}
- Type: ${node.type}
- Community: ${node.community ?? "none"}
- Connections (degree): ${node.degree ?? "unknown"}
- Betweenness centrality: ${node.betweenness ? Number(node.betweenness).toFixed(0) : "unknown"}
` : "No node currently selected."}${pathStr ? `
Current path being explored: ${pathStr}
` : ""}
Node types in the vault: concept, person, source, project, synthesis, entity.
Relationships: RELATED_TO (explicit connections), LINKS_TO (wikilinks), AUTHORED_BY (person→work).

Help the user explore and understand the intellectual connections in their knowledge vault. Be concise and insightful. After your main response, output exactly one line:
SUGGESTIONS: ["follow-up question 1", "follow-up question 2", "follow-up question 3"]
Make suggestions specific to what was just discussed and the current graph state.`;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const BOLT = process.env.NEO4J_BOLT || "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASS = process.env.NEO4J_PASS || "neo4jpass";

const driver = neo4j.driver(BOLT, neo4j.auth.basic(NEO4J_USER, NEO4J_PASS));

const app = express();
app.use(express.json());

// ─── API endpoints ────────────────────────────────────────────────────────────

app.get("/api/graph", async (req, res) => {
  const session = driver.session();
  try {
    const nodeResult = await session.run(`
      MATCH (n:WikiPage)
      RETURN n.slug       AS id,
             n.title      AS title,
             n.type       AS type,
             n.path       AS path,
             n.community_id AS community,
             n.betweenness  AS betweenness,
             n.degree       AS degree,
             n.stub         AS stub
    `);

    const edgeResult = await session.run(`
      MATCH (a:WikiPage)-[r]->(b:WikiPage)
      WHERE type(r) IN ['RELATED_TO','LINKS_TO','AUTHORED_BY']
      RETURN a.slug AS source, b.slug AS target,
             type(r) AS relType, r.weight AS weight
    `);

    const nodes = nodeResult.records.map((rec) => ({
      id:        rec.get("id"),
      title:     rec.get("title"),
      type:      rec.get("type"),
      path:      rec.get("path"),
      community: rec.get("community") != null ? rec.get("community").toNumber?.() ?? rec.get("community") : null,
      betweenness: rec.get("betweenness") ?? 0,
      degree:    rec.get("degree") != null ? rec.get("degree").toNumber?.() ?? rec.get("degree") : 1,
      stub:      rec.get("stub") ?? false,
    }));

    const links = edgeResult.records.map((rec) => ({
      source:  rec.get("source"),
      target:  rec.get("target"),
      relType: rec.get("relType"),
      weight:  rec.get("weight") ?? 0.5,
    }));

    res.json({ nodes, links });
  } catch (err) {
    console.error("Graph query failed:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    await session.close();
  }
});

app.get("/api/neighbors/:slug", async (req, res) => {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (center:WikiPage {slug: $slug})-[r]-(neighbor:WikiPage)
      RETURN neighbor.slug AS id, neighbor.title AS title, neighbor.type AS type,
             neighbor.community_id AS community, neighbor.degree AS degree,
             type(r) AS relType, r.weight AS weight
      `,
      { slug: req.params.slug }
    );
    res.json(result.records.map((rec) => ({
      id:        rec.get("id"),
      title:     rec.get("title"),
      type:      rec.get("type"),
      community: rec.get("community"),
      degree:    rec.get("degree"),
      relType:   rec.get("relType"),
      weight:    rec.get("weight"),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await session.close();
  }
});

app.get("/api/path", async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: "from and to required" });
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (a:WikiPage {title: $from}), (b:WikiPage {title: $to})
      CALL gds.shortestPath.dijkstra.stream('vault', {
        sourceNode: a, targetNode: b,
        relationshipWeightProperty: 'weight'
      })
      YIELD nodeIds, totalCost
      RETURN [nid IN nodeIds | gds.util.asNode(nid).title] AS chain, totalCost
      LIMIT 1
      `,
      { from, to }
    );
    if (result.records.length === 0) return res.json({ chain: [], cost: null });
    res.json({
      chain: result.records[0].get("chain"),
      cost: result.records[0].get("totalCost"),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await session.close();
  }
});

app.get("/api/note", (req, res) => {
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ error: "path required" });
  // security: disallow path traversal outside vault
  const abs = path.resolve(VAULT_ROOT, relPath);
  if (!abs.startsWith(VAULT_ROOT)) return res.status(403).json({ error: "forbidden" });
  const note = readNote(relPath);
  if (!note) return res.status(404).json({ error: "not found" });
  res.json(note);
});

app.get("/api/structural-similarity", async (req, res) => {
  const session = driver.session();
  try {
    await session.run(`
      CALL gds.fastRP.write('vault', {
        embeddingDimension: 64,
        randomSeed: 42,
        iterationWeights: [0.0, 1.0, 1.0, 0.5],
        writeProperty: 'fastrp_embedding'
      })
      YIELD nodePropertiesWritten
      RETURN nodePropertiesWritten
    `);

    await session.run("CALL gds.graph.drop('vault-knn', false) YIELD graphName RETURN graphName");
    await session.run(`
      CALL gds.graph.project('vault-knn', 'WikiPage', {
        RELATED_TO: { orientation: 'UNDIRECTED' },
        LINKS_TO:   { orientation: 'UNDIRECTED' }
      }, {
        nodeProperties: ['fastrp_embedding', 'community_id']
      })
      YIELD graphName, nodeCount
      RETURN graphName, nodeCount
    `);

    const result = await session.run(`
      CALL gds.knn.stream('vault-knn', {
        topK: 6,
        nodeProperties: [{ fastrp_embedding: 'COSINE' }],
        randomSeed: 42,
        concurrency: 1
      })
      YIELD node1, node2, similarity
      WITH gds.util.asNode(node1) AS a, gds.util.asNode(node2) AS b, similarity
      WHERE a.community_id IS NOT NULL AND b.community_id IS NOT NULL
        AND a.community_id <> b.community_id
        AND similarity > 0.65
      RETURN a.slug AS sourceId, a.title AS sourceTitle,
             a.community_id AS communityA, a.type AS typeA,
             b.slug AS targetId, b.title AS targetTitle,
             b.community_id AS communityB, b.type AS typeB,
             round(similarity * 1000) / 1000 AS similarity
      ORDER BY similarity DESC LIMIT 25
    `);

    await session.run("CALL gds.graph.drop('vault-knn', false) YIELD graphName RETURN graphName");

    res.json(result.records.map(r => ({
      sourceId:    r.get("sourceId"),
      sourceTitle: r.get("sourceTitle"),
      communityA:  r.get("communityA") != null ? (r.get("communityA").toNumber?.() ?? r.get("communityA")) : null,
      typeA:       r.get("typeA"),
      targetId:    r.get("targetId"),
      targetTitle: r.get("targetTitle"),
      communityB:  r.get("communityB") != null ? (r.get("communityB").toNumber?.() ?? r.get("communityB")) : null,
      typeB:       r.get("typeB"),
      similarity:  r.get("similarity"),
    })));
  } catch (err) {
    console.error("Structural similarity failed:", err.message);
    res.json({ error: err.message, pairs: [] });
  } finally {
    await session.close();
  }
});

app.get("/api/suggestions", async (req, res) => {
  const session = driver.session();
  try {
    const result = await session.run(`
      MATCH (a:WikiPage)-[:RELATED_TO]-(common:WikiPage)-[:RELATED_TO]-(b:WikiPage)
      WHERE id(a) < id(b)
        AND NOT (a)-[:RELATED_TO]-(b)
      WITH a, b, collect(DISTINCT common) AS commons
      WITH a, b, commons,
           reduce(score = 0.0, c IN commons |
             score + 1.0 / (log(size([(c)-[:RELATED_TO]-() | 1])) + 0.0001)
           ) AS score
      WHERE score > 1.0
      RETURN a.slug AS sourceId, a.title AS sourceTitle,
             b.slug AS targetId, b.title AS targetTitle,
             round(score * 1000) / 1000 AS score
      ORDER BY score DESC LIMIT 30
    `);
    res.json(result.records.map(r => ({
      sourceId:    r.get("sourceId"),
      sourceTitle: r.get("sourceTitle"),
      targetId:    r.get("targetId"),
      targetTitle: r.get("targetTitle"),
      score:       r.get("score"),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await session.close();
  }
});

app.get("/api/communities", async (req, res) => {
  const session = driver.session();
  try {
    const result = await session.run(`
      MATCH (n:WikiPage)
      WHERE n.community_id IS NOT NULL
      WITH n.community_id AS cid, count(*) AS size,
           collect(n.title)[..4] AS sample
      RETURN cid, size, sample
      ORDER BY size DESC
    `);
    res.json(result.records.map(r => ({
      id:     r.get("cid") != null ? (r.get("cid").toNumber?.() ?? r.get("cid")) : null,
      size:   r.get("size").toNumber?.() ?? r.get("size"),
      sample: r.get("sample"),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await session.close();
  }
});

// ─── AI Chat endpoint ─────────────────────────────────────────────────────────

app.post("/api/chat", async (req, res) => {
  const { messages, context, provider, model } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array required" });
  }

  const aiModel = getAIProvider(provider || process.env.DEFAULT_AI_PROVIDER || "ollama", model);
  const system = buildSystemPrompt(context || {});

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  try {
    const result = streamText({ model: aiModel, system, messages, maxTokens: 1024 });
    for await (const chunk of result.textStream) {
      res.write(chunk);
    }
    res.end();
  } catch (err) {
    console.error("Chat error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.end(`\n\nError: ${err.message}`);
    }
  }
});

// ─── Static ───────────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`PKM Graph Viz running at http://localhost:${PORT}`);
  console.log(`Connected to Neo4j at ${BOLT}`);
});
