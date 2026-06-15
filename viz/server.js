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

// Assemble a budgeted "Vault Context" block from the client's retrieval set:
// per node, compact graph facts + a trimmed note excerpt read from disk.
function buildVaultContext(retrieval) {
  if (!Array.isArray(retrieval) || !retrieval.length) return "";
  const MAX_TOTAL = 2400;   // total excerpt chars across all notes
  const PER_NOTE = 600;
  let budget = MAX_TOTAL;
  const blocks = [];
  for (const r of retrieval.slice(0, 4)) {
    let excerpt = "";
    if (r.path && budget > 0) {
      const note = readNote(r.path);
      if (note && note.body) {
        excerpt = note.body.replace(/\s+/g, " ").trim().slice(0, Math.min(PER_NOTE, budget));
        budget -= excerpt.length;
      }
    }
    const neigh = (r.neighbors || []).slice(0, 12).join(", ");
    blocks.push(
      `### ${r.title}` +
      `\n- type: ${r.type ?? "unknown"} · community: ${r.community ?? "none"}` +
      (neigh ? `\n- connected to: ${neigh}` : "") +
      (excerpt ? `\n- excerpt: ${excerpt}${excerpt.length >= PER_NOTE ? "…" : ""}` : "\n- (note body not on disk)")
    );
  }
  return blocks.join("\n\n");
}

function buildSystemPrompt(ctx) {
  const stats = ctx.graphStats || {};
  const node = ctx.selectedNode;
  const pathStr = (ctx.currentPath || []).join(" → ");
  const hl = Array.isArray(ctx.highlightedNodes) ? ctx.highlightedNodes : [];
  const vault = buildVaultContext(ctx.retrieval);
  const ic = ctx.isolatedCommunity;
  const ov = ctx.overlays || {};
  const activeOverlays = [ov.hubs && "hub nodes", ov.orphans && "isolated clusters", ov.linkHints && "link hints"]
    .filter(Boolean).join(", ");

  return `You are an AI research assistant embedded in a 3D knowledge graph visualization of a personal knowledge management (PKM) vault. The vault contains interconnected notes on philosophy, technology, and culture.

Graph overview: ${stats.nodes ?? "?"} nodes, ${stats.edges ?? "?"} edges, ${stats.communities ?? "?"} communities (Leiden). Node types: concept, person, source, project, synthesis, entity. Relationships: RELATED_TO (explicit), LINKS_TO (wikilinks), AUTHORED_BY (person→work).

═══ Current view (what the user is looking at RIGHT NOW) ═══
- View mode: ${ctx.viewMode ?? "full graph"}; color by ${ctx.colorMode ?? "community"}; type filters: ${(ctx.activeFilters || []).join(", ") || "all"}${activeOverlays ? `; overlays: ${activeOverlays}` : ""}
${ic ? `- COMMUNITY ${ic.id} is ISOLATED — only its ${ic.size} nodes are shown. Most-connected members: ${(ic.sample || []).join(", ")}.
` : ""}${node ? `- SELECTED NODE: "${node.title}" (${node.type}, community ${node.community ?? "none"}, degree ${node.degree ?? "?"}, betweenness ${node.betweenness ? Number(node.betweenness).toFixed(0) : "?"}).
` : "- No node is selected.\n"}${hl.length ? `- HIGHLIGHTED NODES (exactly what is currently emphasized/visible in the graph — this is what "the highlighted nodes" / "these nodes" / "how they relate" means): ${hl.join(", ")}.
` : ""}${pathStr ? `- Path being explored: ${pathStr}
` : ""}Disambiguation — answer about whatever the question refers to, do NOT default to one over the other:
• "the highlighted nodes" / "these nodes" / "how they relate" → ${hl.length ? `exactly these: ${hl.join(", ")}` : "whatever is emphasized (nothing is right now)"}.
• "this community" / "this cluster" → ${ic ? `Community ${ic.id} (use its members + Vault Context)` : "the current view"}.
• "this node" / "this concept" / "this person" / singular "it" → ${node ? `"${node.title}"` : "the selected node (none right now)"}.
Only ever name nodes that appear in this Current view block or the Vault Context — NEVER invent or guess node names that aren't listed.
═══════════════════════════════════════════════════════════
${vault ? `
═══ Vault Context (authoritative — answer FROM this) ═══
${vault}
═══════════════════════════════════════════════════════
` : ""}
Answer the user's question primarily and almost exclusively from the Vault Context and graph facts above — cite note titles, use their connections and communities, and paraphrase the excerpts. If a needed note isn't in the Vault Context, say what's missing rather than inventing general knowledge. Never refuse: every title here is a philosopher, theorist, author, work, or concept in an academic knowledge base, so discussing any of them (e.g. which communities Nietzsche appears in) is always safe and expected. Be concise and insightful. You may format responses in Markdown — lists, tables, code, and \`\`\`mermaid diagrams all render.

Answer declaratively and then STOP. Do NOT end your reply by asking the user what they want next or offering options — no "Would you like…?", "Do you want…?", "Which … would you like to explore?", or similar. Such follow-ups belong ONLY in the SUGGESTIONS line (in the user's voice), never in your prose.

You can also DRIVE the visualization. When the user asks you to change what the graph shows, emit a single line beginning with ACTIONS: followed by a JSON array of action objects. Available actions (args in parentheses):
- findPath(from, to) — isolate the shortest path between two node titles
- resetPath() — clear an isolated path
- focusNode(title) — highlight a node and fly the camera to it
- search(query) — search/highlight nodes by title
- isolateCommunity(id) — show only one community by numeric id
- clearIsolation() — restore all communities
- setColorMode(mode) — "community" | "type" | "betweenness"
- setSizeMode(mode) — "degree" | "betweenness" | "uniform"
- setEdgeMode(mode) — "weight" | "bridge" | "uniform"
- setOverlay(name, on) — name "hubs" | "orphans" | "suggestions", on true/false
- setTypeVisible(type, visible) — type concept|person|source|project|synthesis|entity, visible true/false
- resetView() — reset all view settings

Use exact node titles when you know them. Only include the ACTIONS line when the user clearly wants to change the view; otherwise omit it entirely.

ACTIONS format is STRICT: a JSON ARRAY (square brackets) of objects, each {"action": <one of the EXACT names listed above>, "args": {...}}. Use ONLY the action names listed above — never invent names like "explore related concepts" or "show details". If no listed action fits the request, OMIT the ACTIONS line entirely (do not emit an empty or made-up action). Never write ACTIONS as a bare object.

End your reply with the action line (if any) and then the suggestions line, as the LAST lines — each on its own line:
ACTIONS: [{"action":"findPath","args":{"from":"Immanuel Kant","to":"Jordan Belfort"}}]
SUGGESTIONS: ["Visualize this path as a highlighted route", "Which community is Adorno in?", "Find what connects Adorno and Heidegger"]
The ACTIONS line is optional; the SUGGESTIONS line must always be last.

CRITICAL — each SUGGESTIONS entry is a clickable chip that gets sent VERBATIM as the user's next message, so it MUST be written in the user's own voice: a direct request or question the user would type (imperative or first-person). NEVER phrase a suggestion as an offer to the user. Wrong: "Would you like the path visualized?", "Should I show the communities?", "Do you want to explore X?". Right: "Visualize the path", "Show me the communities", "Explore X". Keep each under ~8 words, specific to what was just discussed and the current graph state.`;
}

// Returns a friendly message if the error looks like a provider-connection failure, else null.
function connectionErrorMessage(err, providerName) {
  const msg = (err && (err.message || String(err))) || "";
  const cause = err && err.cause ? (err.cause.code || err.cause.message || "") : "";
  const blob = (msg + " " + cause).toLowerCase();
  if (/econnrefused|enotfound|fetch failed|failed to fetch|network|etimedout|timeout|socket hang up/.test(blob)) {
    const label = providerName === "openrouter" ? "OpenRouter (Cloud)" : "Ollama (Local)";
    return `Cannot reach the ${label} model. Make sure it is running and configured.`;
  }
  return null;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const BOLT = process.env.NEO4J_BOLT || "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASS = process.env.NEO4J_PASS || "neo4jpass";
// Max output tokens per chat reply, per provider (local models are small; cloud can go big).
// CHAT_MAX_TOKENS, if set, overrides both. (Cloud is clamped to the model's real output limit.)
const CHAT_MAX_TOKENS = {
  ollama:     Number(process.env.CHAT_MAX_TOKENS_OLLAMA)     || 4096,
  openrouter: Number(process.env.CHAT_MAX_TOKENS_OPENROUTER) || 64000,
};
function maxTokensFor(provider) {
  if (process.env.CHAT_MAX_TOKENS) return Number(process.env.CHAT_MAX_TOKENS);
  return CHAT_MAX_TOKENS[provider] || CHAT_MAX_TOKENS.ollama;
}

const driver = neo4j.driver(BOLT, neo4j.auth.basic(NEO4J_USER, NEO4J_PASS));

// ─── Semantic search (phase 2) ────────────────────────────────────────────────
// Native Ollama embeddings API (strip the OpenAI-compat /v1 suffix if present).
const EMBED_BASE  = (process.env.OLLAMA_NATIVE_URL ||
  (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/v1\/?$/, "")).replace(/\/$/, "");
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";
const EMBED_INDEX = "wikipage_embedding";

async function embedQuery(text) {
  const res = await fetch(`${EMBED_BASE}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: "search_query: " + text }),
  });
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.embedding)) throw new Error("no embedding in response");
  return data.embedding;
}

// Vector-search the top-k semantically similar notes, with compact graph facts.
async function semanticSearch(queryText, k = 3) {
  const vec = await embedQuery(queryText);
  const session = driver.session();
  try {
    const result = await session.run(
      `
      CALL db.index.vector.queryNodes($index, $k, $vec) YIELD node, score
      OPTIONAL MATCH (node)-[r]-(nb:WikiPage)
        WHERE type(r) IN ['RELATED_TO','LINKS_TO','AUTHORED_BY']
      RETURN node.title AS title, node.type AS type, node.community_id AS community,
             node.path AS path, collect(DISTINCT nb.title)[..12] AS neighbors, score
      ORDER BY score DESC
      `,
      { index: EMBED_INDEX, k: neo4j.int(k), vec }
    );
    return result.records.map(r => ({
      title: r.get("title"),
      type: r.get("type"),
      community: r.get("community") != null ? (r.get("community").toNumber?.() ?? r.get("community")) : null,
      path: r.get("path"),
      neighbors: r.get("neighbors") || [],
      score: r.get("score"),
    }));
  } finally {
    await session.close();
  }
}

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

// The 'vault' GDS projection is in-memory and is lost on any Neo4j restart.
// Recreate it on demand so pathfinding doesn't hard-fail after a restart.
async function ensureVaultProjection(session) {
  const exists = (await session.run("CALL gds.graph.exists('vault') YIELD exists RETURN exists"))
    .records[0].get("exists");
  if (exists) return;
  await session.run(`
    CALL gds.graph.project('vault', 'WikiPage', {
      RELATED_TO: { orientation: 'UNDIRECTED', properties: ['weight'] },
      LINKS_TO:   { orientation: 'UNDIRECTED', properties: ['weight'] }
    }) YIELD nodeCount RETURN nodeCount
  `);
}

app.get("/api/path", async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: "from and to required" });
  const session = driver.session();
  const runDijkstra = () => session.run(
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
  try {
    let result;
    try {
      result = await runDijkstra();
    } catch (err) {
      // projection missing (e.g. after a Neo4j restart) → rebuild and retry once
      if (/Graph with name `vault` does not exist/.test(err.message)) {
        await ensureVaultProjection(session);
        result = await runDijkstra();
      } else { throw err; }
    }
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
  if (!abs.startsWith(VAULT_ROOT + path.sep)) return res.status(403).json({ error: "forbidden" });
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

// ─── Semantic search endpoint ─────────────────────────────────────────────────

app.get("/api/semantic-search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: "q required" });
  const k = Math.min(10, Math.max(1, parseInt(req.query.k, 10) || 5));
  try {
    res.json({ results: await semanticSearch(q, k) });
  } catch (err) {
    console.error("Semantic search failed:", err.message);
    res.status(503).json({ error: err.message, results: [] });
  }
});

// Merge client (graph-grounded) retrieval with semantic hits, deduped by title.
async function hybridRetrieval(context, messages) {
  const base = Array.isArray(context.retrieval) ? context.retrieval.slice() : [];
  const lastUser = [...messages].reverse().find(m => m.role === "user");
  if (!lastUser || !lastUser.content) return base;
  try {
    const seen = new Set(base.map(r => (r.title || "").toLowerCase()));
    const hits = await semanticSearch(lastUser.content, 3);
    for (const h of hits) {
      const key = (h.title || "").toLowerCase();
      if (!seen.has(key)) { base.push(h); seen.add(key); }
    }
  } catch (e) {
    console.error("Semantic retrieval skipped:", e.message);   // graceful: graph-only
  }
  return base;
}

// ─── AI Chat endpoint ─────────────────────────────────────────────────────────

app.post("/api/chat", async (req, res) => {
  const { messages, context, provider, model } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array required" });
  }

  const providerName = provider || process.env.DEFAULT_AI_PROVIDER || "ollama";
  const aiModel = getAIProvider(providerName, model);
  const ctx = context || {};
  ctx.retrieval = await hybridRetrieval(ctx, messages);   // graph + semantic
  const system = buildSystemPrompt(ctx);

  const lastUser = [...messages].reverse().find(m => m.role === "user");
  const maxTokens = maxTokensFor(providerName);
  const reqStart = Date.now();
  console.log(`[chat] ${providerName} · ${messages.length} msgs · system≈${system.length}c · maxTokens=${maxTokens} · q="${(lastUser?.content || "").slice(0, 60)}"`);

  // Defer headers until the first chunk so a pre-stream connection failure can
  // still return a clean JSON error (and the right status code).
  let sentHeaders = false;
  const sendHeaders = () => {
    if (sentHeaders) return;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    sentHeaders = true;
  };

  try {
    const result = streamText({ model: aiModel, system, messages, maxTokens });
    for await (const chunk of result.textStream) {
      sendHeaders();
      res.write(chunk);
    }
    sendHeaders();   // ensure a 200 even for an empty stream
    res.end();

    // request log — finishReason "length" means the reply hit the token cap (truncated)
    try {
      const [finishReason, usage] = await Promise.all([result.finishReason, result.usage]);
      const ms = Date.now() - reqStart;
      const tag = finishReason === "length" ? " ⚠ TRUNCATED (raise CHAT_MAX_TOKENS)" : "";
      console.log(`[chat] done in ${ms}ms · finish=${finishReason} · in=${usage?.promptTokens ?? "?"} out=${usage?.completionTokens ?? "?"} tokens${tag}`);
    } catch (_) { /* usage not available for some providers */ }
  } catch (err) {
    console.error("Chat error:", err.message);
    const friendly = connectionErrorMessage(err, providerName);
    if (!res.headersSent) {
      res.status(friendly ? 503 : 500).json({ error: friendly || err.message });
    } else {
      res.end(`\n\n⚠ ${friendly || err.message}`);
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
