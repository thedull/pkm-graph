#!/usr/bin/env python3
"""
PKM Knowledge Graph sync + GDS discovery script.

Modes:
  (default)        Parse vault and upsert all nodes/edges into Neo4j
  --project-only   Drop and recreate the GDS named graph projection only
  --discover-only  Run GDS algorithms and output discovery JSON to stdout
"""

import argparse
import fnmatch
import json
import os
import pathlib
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import date
from typing import Dict, List, Optional

import frontmatter
from neo4j import GraphDatabase

# ── Semantic embeddings (phase 2) ──────────────────────────────────────────────
# Ollama native API (no /v1); model produces 768-dim vectors for nomic-embed-text.
EMBED_BASE   = os.environ.get("OLLAMA_NATIVE_URL", "http://localhost:11434").rstrip("/")
EMBED_MODEL  = os.environ.get("EMBED_MODEL", "nomic-embed-text")
EMBED_DIMS   = int(os.environ.get("EMBED_DIMS", "768"))
EMBED_INDEX  = "wikipage_embedding"
EMBED_MAX_CHARS = 2000   # truncate note body before embedding

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

WIKILINK_RE = re.compile(r'\[\[([^\]|#\n]+?)(?:[|#][^\]\n]*)?\]\]')

TYPE_TO_LABEL = {
    "concept":   "Concept",
    "source":    "Source",
    "person":    "Person",
    "project":   "Project",
    "synthesis": "Synthesis",
    "entity":    "Entity",
    "artifact":  "Artifact",
    "unknown":   "Unknown",
}

GRAPH_NAME = "vault"

# GDS pathfinding pairs (source title → target title)
# Load from pathfinding.json (gitignored) so personal vault content stays out of the repo.
# Copy pathfinding.example.json → pathfinding.json and fill in your own node titles.
_pairs_path = pathlib.Path(__file__).parent / "pathfinding.json"
PATHFINDING_PAIRS = json.load(open(_pairs_path)) if _pairs_path.exists() else []


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def extract_wikilinks(text: str) -> List[str]:
    return [m.strip() for m in WIKILINK_RE.findall(text)]


def parse_note(path: pathlib.Path, vault_root: pathlib.Path) -> dict:
    try:
        post = frontmatter.load(str(path))
    except Exception as e:
        print(f"  WARN: could not parse {path}: {e}", file=sys.stderr)
        return None

    meta = post.metadata
    body = post.content
    slug = path.stem
    rel_path = str(path.relative_to(vault_root))

    # frontmatter related: links
    raw_related = meta.get("related") or []
    if isinstance(raw_related, str):
        raw_related = [raw_related]
    fm_links = []
    for item in raw_related:
        if isinstance(item, str):
            found = extract_wikilinks(item)
            fm_links.extend(found)
            if not found and item.strip():
                fm_links.append(item.strip())

    # body wikilinks (exclude those already in frontmatter related)
    fm_set = set(fm_links)
    body_links = [l for l in extract_wikilinks(body) if l not in fm_set]

    # author cleanup: strip parenthetical annotations
    author = meta.get("author") or ""
    if author:
        author = re.sub(r'\s*\([^)]*\)', '', str(author)).strip()
        if author.lower() in ("unknown", "various", ""):
            author = ""

    return {
        "slug":          slug,
        "path":          rel_path,
        "type":          str(meta.get("type") or "unknown").lower(),
        "title":         str(meta.get("title") or slug),
        "aliases":       list(meta.get("aliases") or []),
        "author":        author,
        "date_added":    str(meta.get("date_added") or ""),
        "date_ingested": str(meta.get("date_ingested") or ""),
        "confidence":    str(meta.get("confidence") or ""),
        "status":        str(meta.get("status") or ""),
        "stub":          bool(meta.get("stub", False)),
        "domain":        str(meta.get("domain") or ""),
        "born":          str(meta.get("born") or ""),
        "died":          str(meta.get("died") or ""),
        "nationality":   str(meta.get("nationality") or ""),
        "entity_type":   str(meta.get("entity_type") or ""),
        "fm_links":      fm_links,
        "body_links":    body_links,
        "body":          body,
    }


# ---------------------------------------------------------------------------
# .graphignore (gitignore-style exclusions)
# ---------------------------------------------------------------------------

def load_graphignore(path: pathlib.Path) -> List[str]:
    """Read .graphignore patterns (skipping blanks and # comments)."""
    if not path.exists():
        return []
    pats = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            pats.append(line)
    return pats


def is_ignored(relpath: str, patterns: List[str]) -> bool:
    """Match a vault-relative note path against .graphignore patterns."""
    rp = relpath.replace(os.sep, "/")
    segs = rp.split("/")
    base = segs[-1]
    for pat in patterns:
        if pat.endswith("/"):                          # directory pattern
            d = pat.rstrip("/")
            d = d[3:] if d.startswith("**/") else d
            if "/" not in d:                           # bare dir name → any segment
                if d in segs:
                    return True
            elif rp == d or rp.startswith(d + "/"):    # anchored dir prefix
                return True
        else:                                          # file/glob pattern
            p = pat[3:] if pat.startswith("**/") else pat
            if "/" in p:
                if fnmatch.fnmatch(rp, p) or fnmatch.fnmatch(rp, "*/" + p):
                    return True
            elif fnmatch.fnmatch(base, p):
                return True
    return False


def collect_notes(wiki_dir: pathlib.Path, vault_root: pathlib.Path,
                  ignore: Optional[List[str]] = None) -> List[dict]:
    ignore = ignore or []
    notes = []
    for md_file in wiki_dir.rglob("*.md"):
        rel = str(md_file.relative_to(vault_root))
        if is_ignored(rel, ignore):
            continue
        note = parse_note(md_file, vault_root)
        if note:
            notes.append(note)
    return notes


def build_slug_index(notes: List[dict]) -> Dict[str, str]:
    """Map every title variant → canonical slug."""
    index = {}
    for note in notes:
        index[note["slug"]] = note["slug"]
        # title as lookup key (case-insensitive)
        index[note["title"].lower()] = note["slug"]
        for alias in note["aliases"]:
            if isinstance(alias, str):
                index[alias.lower()] = note["slug"]
                index[alias] = note["slug"]
    return index


def resolve_link(link: str, slug_index: Dict[str, str]) -> Optional[str]:
    """Return canonical slug for a wikilink text, or None if unresolved."""
    return (
        slug_index.get(link)
        or slug_index.get(link.lower())
        or slug_index.get(link.strip())
        or slug_index.get(link.strip().lower())
    )


# ---------------------------------------------------------------------------
# Incremental sync state
# ---------------------------------------------------------------------------

def load_sync_state(state_path: pathlib.Path) -> dict:
    if state_path.exists():
        try:
            return json.loads(state_path.read_text())
        except Exception:
            return {}
    return {}


def save_sync_state(state_path: pathlib.Path, state: dict):
    state_path.write_text(json.dumps(state, indent=2))


# ---------------------------------------------------------------------------
# Neo4j writes
# ---------------------------------------------------------------------------

def upsert_nodes(session, notes: List[dict], verbose: bool):
    for note in notes:
        label = TYPE_TO_LABEL.get(note["type"], "Unknown")
        session.run(
            f"""
            MERGE (n:WikiPage:{label} {{slug: $slug}})
            SET n.title        = $title,
                n.path         = $path,
                n.type         = $type,
                n.stub         = $stub,
                n.status       = $status,
                n.date_added   = $date_added,
                n.date_ingested= $date_ingested,
                n.confidence   = $confidence,
                n.author       = $author,
                n.domain       = $domain,
                n.born         = $born,
                n.died         = $died,
                n.nationality  = $nationality,
                n.entity_type  = $entity_type
            """,
            slug=note["slug"], title=note["title"], path=note["path"],
            type=note["type"], stub=note["stub"], status=note["status"],
            date_added=note["date_added"], date_ingested=note["date_ingested"],
            confidence=note["confidence"], author=note["author"],
            domain=note["domain"], born=note["born"], died=note["died"],
            nationality=note["nationality"], entity_type=note["entity_type"],
        )
        if verbose:
            print(f"  node  [{label}] {note['slug']}")


def upsert_edges(session, notes: List[dict], slug_index: Dict, verbose: bool):
    counts = {"RELATED_TO": 0, "LINKS_TO": 0, "AUTHORED_BY": 0, "unresolved": 0}

    for note in notes:
        src = note["slug"]

        for link in note["fm_links"]:
            tgt = resolve_link(link, slug_index)
            if tgt and tgt != src:
                session.run(
                    """
                    MATCH (a:WikiPage {slug: $src}), (b:WikiPage {slug: $tgt})
                    MERGE (a)-[r:RELATED_TO]->(b)
                    SET r.weight = 1.0, r.source = 'frontmatter'
                    """,
                    src=src, tgt=tgt,
                )
                counts["RELATED_TO"] += 1
            elif not tgt:
                counts["unresolved"] += 1

        for link in note["body_links"]:
            tgt = resolve_link(link, slug_index)
            if tgt and tgt != src:
                session.run(
                    """
                    MATCH (a:WikiPage {slug: $src}), (b:WikiPage {slug: $tgt})
                    MERGE (a)-[r:LINKS_TO]->(b)
                    SET r.weight = 0.5, r.source = 'body'
                    """,
                    src=src, tgt=tgt,
                )
                counts["LINKS_TO"] += 1

        if note["author"]:
            author_slug = resolve_link(note["author"], slug_index)
            if author_slug and author_slug != src:
                session.run(
                    """
                    MATCH (a:WikiPage {slug: $src}), (b:WikiPage {slug: $tgt})
                    MERGE (a)-[r:AUTHORED_BY]->(b)
                    SET r.weight = 1.0, r.source = 'author_field'
                    """,
                    src=src, tgt=author_slug,
                )
                counts["AUTHORED_BY"] += 1

    return counts


# ---------------------------------------------------------------------------
# Semantic embeddings (Ollama) + Neo4j vector index
# ---------------------------------------------------------------------------

def ollama_embed(text: str, prefix: str = "search_document: ", quiet: bool = False) -> Optional[List[float]]:
    """Embed text via the Ollama native API. Returns a vector or None on failure."""
    payload = json.dumps({"model": EMBED_MODEL, "prompt": prefix + text}).encode("utf-8")
    req = urllib.request.Request(
        f"{EMBED_BASE}/api/embeddings", data=payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
        vec = data.get("embedding")
        return vec if isinstance(vec, list) and vec else None
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        if not quiet:
            print(f"  WARN: embedding failed: {e}", file=sys.stderr)
        return None


def ensure_vector_index(session, verbose: bool):
    # Neo4j 5.14 uses the procedure form (the CREATE VECTOR INDEX syntax is 5.15+).
    names = [r["name"] for r in session.run("SHOW INDEXES YIELD name RETURN name")]
    if EMBED_INDEX in names:
        if verbose:
            print(f"  Vector index '{EMBED_INDEX}' already exists")
        return
    session.run(
        "CALL db.index.vector.createNodeIndex($name, 'WikiPage', 'text_embedding', $dims, 'cosine')",
        name=EMBED_INDEX, dims=EMBED_DIMS,
    )
    if verbose:
        print(f"  Vector index '{EMBED_INDEX}' created ({EMBED_DIMS}-dim, cosine)")


def embed_notes(session, notes: List[dict], verbose: bool) -> int:
    """Embed each note's title+body and store as n.text_embedding. Returns count written."""
    # one quiet health check so a missing model doesn't spam a warning per note
    if ollama_embed("ping", quiet=True) is None:
        print(f"  Embedding model '{EMBED_MODEL}' unavailable at {EMBED_BASE} — skipping "
              f"(run: ollama pull {EMBED_MODEL})", file=sys.stderr)
        return 0
    written = 0
    for i, note in enumerate(notes, 1):
        body = (note.get("body") or "").strip()
        text = f"{note['title']}\n{body}"[:EMBED_MAX_CHARS]
        vec = ollama_embed(text)
        if not vec:
            continue
        session.run(
            "MATCH (n:WikiPage {slug: $slug}) SET n.text_embedding = $vec",
            slug=note["slug"], vec=vec,
        )
        written += 1
        if verbose or i % 50 == 0:
            print(f"  embedded {i}/{len(notes)}", file=sys.stderr)
    return written


# ---------------------------------------------------------------------------
# Prune (remove ignored / stale nodes)
# ---------------------------------------------------------------------------

def prune_graph(session, vault_root: pathlib.Path, patterns: List[str], verbose: bool) -> List[str]:
    """Delete nodes whose file is .graphignore'd or no longer exists on disk."""
    rows = [(r["slug"], r["path"]) for r in
            session.run("MATCH (n:WikiPage) WHERE n.path IS NOT NULL RETURN n.slug AS slug, n.path AS path")]
    removed = []
    for slug, path in rows:
        if is_ignored(path, patterns) or not (vault_root / path).exists():
            session.run("MATCH (n:WikiPage {slug: $slug}) DETACH DELETE n", slug=slug)
            removed.append(path)
            if verbose:
                print(f"  pruned {path}", file=sys.stderr)
    return removed


# ---------------------------------------------------------------------------
# GDS graph projection
# ---------------------------------------------------------------------------

def drop_and_project(session, verbose: bool):
    exists = session.run(
        "CALL gds.graph.exists($name) YIELD exists", name=GRAPH_NAME
    ).single()["exists"]

    if exists:
        session.run("CALL gds.graph.drop($name)", name=GRAPH_NAME)
        if verbose:
            print(f"  Dropped existing GDS projection '{GRAPH_NAME}'")

    result = session.run(
        """
        CALL gds.graph.project(
          $name,
          'WikiPage',
          {
            RELATED_TO: { orientation: 'UNDIRECTED', properties: ['weight'] },
            LINKS_TO:   { orientation: 'UNDIRECTED', properties: ['weight'] }
          }
        ) YIELD nodeCount, relationshipCount
        """,
        name=GRAPH_NAME,
    ).single()
    if verbose:
        print(f"  Projected '{GRAPH_NAME}': {result['nodeCount']} nodes, {result['relationshipCount']} rels")
    return result["nodeCount"], result["relationshipCount"]


# ---------------------------------------------------------------------------
# GDS algorithms
# ---------------------------------------------------------------------------

def run_leiden(session, verbose: bool):
    r = session.run(
        """
        CALL gds.leiden.write($name, {
          writeProperty: 'community_id',
          randomSeed: 42,
          gamma: 1.0
        }) YIELD communityCount, modularity
        """,
        name=GRAPH_NAME,
    ).single()
    if verbose:
        print(f"  Leiden: {r['communityCount']} communities, modularity={r['modularity']:.4f}")
    return r["communityCount"]


def run_betweenness(session, verbose: bool):
    session.run(
        """
        CALL gds.betweenness.write($name, { writeProperty: 'betweenness' })
        YIELD nodePropertiesWritten
        """,
        name=GRAPH_NAME,
    )
    top = session.run(
        """
        MATCH (n:WikiPage)
        WHERE n.betweenness IS NOT NULL
        RETURN n.title AS title, n.type AS type, n.betweenness AS score
        ORDER BY score DESC LIMIT 20
        """
    ).data()
    if verbose:
        print(f"  Betweenness: top hub = '{top[0]['title']}' ({top[0]['score']:.1f})")
    return top


def run_degree(session, verbose: bool):
    session.run(
        """
        CALL gds.degree.write($name, {
          writeProperty: 'degree',
          orientation: 'UNDIRECTED'
        }) YIELD nodePropertiesWritten
        """,
        name=GRAPH_NAME,
    )
    if verbose:
        print("  Degree centrality written.")


def run_wcc(session, verbose: bool):
    r = session.run(
        """
        CALL gds.wcc.write($name, { writeProperty: 'component' })
        YIELD componentCount, componentDistribution
        """,
        name=GRAPH_NAME,
    ).single()
    orphans = session.run(
        """
        MATCH (n:WikiPage)
        WITH n.component AS cid, collect(n.title) AS members, count(*) AS sz
        WHERE sz < 10
        RETURN cid, sz, members
        ORDER BY sz ASC LIMIT 20
        """
    ).data()
    if verbose:
        print(f"  WCC: {r['componentCount']} components, {len(orphans)} small (<10 nodes)")
    return orphans


def run_adamic_adar(session, verbose: bool):
    # Pure Cypher implementation — gds.linkprediction.adamicAdar was removed in GDS 2.x
    pairs = session.run(
        """
        MATCH (a:WikiPage)-[:RELATED_TO]-(common:WikiPage)-[:RELATED_TO]-(b:WikiPage)
        WHERE id(a) < id(b)
          AND NOT (a)-[:RELATED_TO]-(b)
        WITH a, b, collect(DISTINCT common) AS commons
        WITH a, b, commons,
             reduce(score = 0.0, c IN commons |
               score + 1.0 / (log(size([(c)-[:RELATED_TO]-() | 1])) + 0.0001)
             ) AS adamicAdar
        WHERE adamicAdar > 1.0
        RETURN a.title AS pageA, a.type AS typeA,
               b.title AS pageB, b.type AS typeB,
               round(adamicAdar * 1000) / 1000 AS similarity
        ORDER BY similarity DESC LIMIT 30
        """
    ).data()
    if verbose:
        print(f"  Adamic-Adar (Cypher): {len(pairs)} candidate pairs (score > 1.0, no existing edge)")
    return pairs


def run_fastrp_knn(session: "neo4j.Session") -> List[Dict]:
    """FastRP structural embeddings + KNN to find cross-community similar nodes."""
    print("  Running FastRP embeddings...")
    session.run(
        """
        CALL gds.fastRP.write('vault', {
          embeddingDimension: 64,
          randomSeed: 42,
          iterationWeights: [0.0, 1.0, 1.0, 0.5],
          writeProperty: 'fastrp_embedding'
        })
        YIELD nodePropertiesWritten RETURN nodePropertiesWritten
        """
    )
    # re-project with embedding property
    session.run("CALL gds.graph.drop('vault-knn', false) YIELD graphName RETURN graphName")
    session.run(
        """
        CALL gds.graph.project('vault-knn', 'WikiPage', {
          RELATED_TO: { orientation: 'UNDIRECTED' },
          LINKS_TO:   { orientation: 'UNDIRECTED' }
        }, { nodeProperties: ['fastrp_embedding', 'community_id'] })
        YIELD graphName RETURN graphName
        """
    )
    print("  Running KNN cross-community similarity...")
    result = session.run(
        """
        CALL gds.knn.stream('vault-knn', {
          topK: 6,
          nodeProperties: [{ fastrp_embedding: 'COSINE' }],
          randomSeed: 42, concurrency: 1
        })
        YIELD node1, node2, similarity
        WITH gds.util.asNode(node1) AS a, gds.util.asNode(node2) AS b, similarity
        WHERE a.community_id IS NOT NULL AND b.community_id IS NOT NULL
          AND a.community_id <> b.community_id
          AND similarity > 0.65
        RETURN a.title AS pageA, a.type AS typeA, a.community_id AS commA,
               b.title AS pageB, b.type AS typeB, b.community_id AS commB,
               round(similarity * 1000) / 1000 AS similarity
        ORDER BY similarity DESC LIMIT 25
        """
    )
    pairs = []
    for rec in result:
        pairs.append({
            "pageA": rec["pageA"], "typeA": rec["typeA"], "commA": rec["commA"],
            "pageB": rec["pageB"], "typeB": rec["typeB"], "commB": rec["commB"],
            "similarity": rec["similarity"],
        })
    session.run("CALL gds.graph.drop('vault-knn', false) YIELD graphName RETURN graphName")
    return pairs


def run_jaccard(session, verbose: bool):
    pairs = session.run(
        """
        CALL gds.nodeSimilarity.stream($name, {
          similarityCutoff: 0.4,
          topK: 10
        })
        YIELD node1, node2, similarity
        WITH gds.util.asNode(node1) AS a, gds.util.asNode(node2) AS b, similarity
        WHERE a.title < b.title
          AND NOT (a)-[:RELATED_TO]-(b)
        RETURN a.title AS pageA, a.type AS typeA,
               b.title AS pageB, b.type AS typeB,
               similarity
        ORDER BY similarity DESC LIMIT 30
        """,
        name=GRAPH_NAME,
    ).data()
    if verbose:
        print(f"  Jaccard similarity: {len(pairs)} candidate pairs")
    return pairs


def run_pathfinding(session, verbose: bool):
    results = []
    for start_title, end_title in PATHFINDING_PAIRS:
        try:
            rows = session.run(
                """
                MATCH (a:WikiPage {title: $start}), (b:WikiPage {title: $end})
                CALL gds.shortestPath.dijkstra.stream($name, {
                  sourceNode: a,
                  targetNode: b,
                  relationshipWeightProperty: 'weight'
                })
                YIELD nodeIds, totalCost
                RETURN [nid IN nodeIds | gds.util.asNode(nid).title] AS chain,
                       totalCost
                LIMIT 1
                """,
                name=GRAPH_NAME, start=start_title, end=end_title,
            ).data()
            if rows:
                results.append({
                    "from": start_title, "to": end_title,
                    "chain": rows[0]["chain"], "cost": rows[0]["totalCost"],
                })
            else:
                results.append({"from": start_title, "to": end_title, "chain": [], "cost": None})
        except Exception as e:
            results.append({"from": start_title, "to": end_title, "chain": [], "cost": None, "error": str(e)})
    if verbose:
        for r in results:
            print(f"  Path {r['from']} → {r['to']}: {' → '.join(r['chain']) if r['chain'] else 'not found'}")
    return results


def get_communities(session):
    return session.run(
        """
        MATCH (n:WikiPage)
        WITH n.community_id AS cid, collect(n.title) AS members, count(*) AS sz
        WHERE sz >= 3
        RETURN cid, sz AS size, members[..8] AS sample
        ORDER BY sz DESC LIMIT 12
        """
    ).data()


def get_graph_stats(session):
    nodes = session.run("MATCH (n:WikiPage) RETURN count(n) AS n").single()["n"]
    edges = session.run("MATCH ()-[r]->() RETURN count(r) AS e").single()["e"]
    related = session.run("MATCH ()-[r:RELATED_TO]->() RETURN count(r) AS e").single()["e"]
    body = session.run("MATCH ()-[r:LINKS_TO]->() RETURN count(r) AS e").single()["e"]
    authored = session.run("MATCH ()-[r:AUTHORED_BY]->() RETURN count(r) AS e").single()["e"]
    return {"nodes": nodes, "edges": edges, "related_to": related, "links_to": body, "authored_by": authored}


# ---------------------------------------------------------------------------
# Discovery report writer
# ---------------------------------------------------------------------------

def write_discovery_report(vault_root: pathlib.Path, discovery: dict):
    today = date.today().isoformat()
    stats = discovery["stats"]
    hubs = discovery["hubs"]
    orphans = discovery["orphans"]
    communities = discovery["communities"]
    aa_pairs = discovery["adamic_adar"]
    jac_pairs = discovery["jaccard"]
    paths = discovery["paths"]
    community_count = discovery["community_count"]
    structural_similarity = discovery.get("structural_similarity", [])

    # Build related: list from top 5 hubs
    related_list = "\n".join(f'  - "[[{h["title"]}]]"' for h in hubs[:5])

    report_path = vault_root / "wiki" / "artifact" / f"Graph Discovery Report {today}.md"

    lines = [
        "---",
        "type: synthesis",
        f'title: "Graph Discovery Report {today}"',
        f"date: {today}",
        "generated_by: graph-discover",
        f"graph_nodes: {stats['nodes']}",
        f"graph_edges: {stats['edges']}",
        "related:",
        related_list,
        "---",
        "",
        f"# Graph Discovery Report — {today}",
        "",
        "## Vault Graph Stats",
        "",
        f"| Metric | Value |",
        f"|---|---|",
        f"| Nodes | {stats['nodes']} |",
        f"| Total edges | {stats['edges']} |",
        f"| RELATED_TO (frontmatter) | {stats['related_to']} |",
        f"| LINKS_TO (body) | {stats['links_to']} |",
        f"| AUTHORED_BY | {stats['authored_by']} |",
        f"| Communities detected | {community_count} |",
        "",
    ]

    # Hub concepts
    lines += [
        "## Hub Concepts (Betweenness Centrality — Top 10)",
        "",
        "| Rank | Page | Type | Score |",
        "|---|---|---|---|",
    ]
    for i, h in enumerate(hubs[:10], 1):
        lines.append(f"| {i} | [[{h['title']}]] | {h['type']} | {h['score']:.1f} |")
    lines.append("")

    # Orphaned clusters
    lines += [
        "## Orphaned Clusters (WCC — Small Components)",
        "",
        "Pages in components with fewer than 10 nodes (not connected to the main graph):",
        "",
    ]
    if orphans:
        for o in orphans[:10]:
            members = ", ".join(f"[[{m}]]" for m in o["members"][:6])
            lines.append(f"- **Cluster** ({o['sz']} nodes): {members}")
    else:
        lines.append("_None — all notes are part of the main connected component._")
    lines.append("")

    # Communities
    lines += [
        "## Intellectual Communities (Leiden — Top Communities)",
        "",
        "| Community ID | Size | Sample Pages |",
        "|---|---|---|",
    ]
    for c in communities:
        sample = ", ".join(f"[[{m}]]" for m in c["sample"][:4])
        lines.append(f"| {c['cid']} | {c['size']} | {sample} |")
    lines.append("")

    # Synthesis candidates (Adamic-Adar)
    lines += [
        "## Synthesis Candidates (Adamic-Adar — Missing Edges, Score > 2.0)",
        "",
        "Pairs with high structural similarity but no existing `related:` link:",
        "",
        "| Page A | Page B | Score |",
        "|---|---|---|",
    ]
    if aa_pairs:
        for p in aa_pairs[:20]:
            lines.append(f"| [[{p['pageA']}]] ({p['typeA']}) | [[{p['pageB']}]] ({p['typeB']}) | {p['similarity']:.2f} |")
    else:
        lines.append("_No high-confidence pairs found._")
    lines.append("")

    # Jaccard similarity candidates
    lines += [
        "## High Neighbor Overlap (Jaccard Similarity — No Existing Edge)",
        "",
        "Pages that reference nearly the same set of concepts (synthesis candidates):",
        "",
        "| Page A | Page B | Similarity |",
        "|---|---|---|",
    ]
    if jac_pairs:
        for p in jac_pairs[:15]:
            lines.append(f"| [[{p['pageA']}]] ({p['typeA']}) | [[{p['pageB']}]] ({p['typeB']}) | {p['similarity']:.3f} |")
    else:
        lines.append("_No high-overlap pairs found._")
    lines.append("")

    # Suggested related: additions
    all_candidates = aa_pairs[:10] + [p for p in jac_pairs[:10] if p not in aa_pairs[:10]]
    lines += [
        "## Suggested `related:` Additions",
        "",
        "<!-- Review before accepting. Add to graph/graph-discover-exclusions.yaml to suppress. -->",
        "",
    ]
    if all_candidates:
        for p in all_candidates[:15]:
            lines.append(f"- [[{p['pageA']}]] → add `[[{p['pageB']}]]`")
    else:
        lines.append("_No suggestions at this time._")
    lines.append("")

    # Pathfinding
    lines += [
        "## Pathfinding Samples",
        "",
    ]
    for r in paths:
        if r["chain"]:
            chain_str = " → ".join(f"[[{n}]]" for n in r["chain"])
            lines.append(f"- **{r['from']} → {r['to']}:** {chain_str} (cost: {r['cost']:.2f})")
        else:
            lines.append(f"- **{r['from']} → {r['to']}:** _path not found_")
    lines.append("")

    # Structural similarity (FastRP + KNN cross-community)
    lines += [
        "## Structural Similarity (Cross-Community)",
        "",
        "Concepts that play structurally similar roles in *different* communities "
        "(FastRP embeddings + KNN cosine similarity > 0.65):",
        "",
        "| Concept A (type, community) | Concept B (type, community) | Similarity |",
        "|---|---|---|",
    ]
    if structural_similarity:
        for p in structural_similarity:
            lines.append(
                f"| [[{p['pageA']}]] ({p['typeA']}, comm {p['commA']}) "
                f"| [[{p['pageB']}]] ({p['typeB']}, comm {p['commB']}) "
                f"| {p['similarity']:.3f} |"
            )
    else:
        lines.append("_No cross-community structural pairs found (or FastRP+KNN was skipped)._")
    lines.append("")

    report_path.write_text("\n".join(lines))
    return str(report_path)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="PKM Knowledge Graph sync + GDS discovery")
    parser.add_argument("--vault", default=".", help="Path to vault root")
    parser.add_argument("--bolt", default="bolt://localhost:7687", help="Neo4j Bolt URL")
    parser.add_argument("--auth", default="neo4j:neo4jpass", help="user:password")
    parser.add_argument("--verbose", "-v", action="store_true")
    parser.add_argument("--project-only", action="store_true", help="Only re-project GDS graph")
    parser.add_argument("--discover-only", action="store_true", help="Run GDS algorithms and write discovery report")
    parser.add_argument("--embed-only", action="store_true", help="(Re)embed all notes and ensure the vector index")
    parser.add_argument("--no-embed", action="store_true", help="Skip embedding during full sync")
    parser.add_argument("--gds", action="store_true", help="Recreate the GDS projection + community/betweenness/degree (no report)")
    parser.add_argument("--prune", action="store_true", help="Remove nodes that are .graphignore'd or missing on disk")
    args = parser.parse_args()

    vault_root = pathlib.Path(args.vault).resolve()
    wiki_dir = vault_root / "wiki"
    state_path = pathlib.Path(__file__).parent / ".sync-state.json"
    ignore_patterns = load_graphignore(pathlib.Path(__file__).parent / ".graphignore")

    user, password = args.auth.split(":", 1)
    driver = GraphDatabase.driver(args.bolt, auth=(user, password))

    try:
        driver.verify_connectivity()
    except Exception as e:
        print(f"ERROR: Cannot connect to Neo4j at {args.bolt}: {e}", file=sys.stderr)
        sys.exit(1)

    with driver.session() as session:

        if args.project_only:
            drop_and_project(session, args.verbose)
            print("GDS projection recreated.")
            driver.close()
            return

        if args.prune:
            print("Pruning ignored / missing nodes...", file=sys.stderr)
            removed = prune_graph(session, vault_root, ignore_patterns, args.verbose)
            print(f"Pruned {len(removed)} node(s).")
            if removed and not args.verbose:
                for p in removed[:10]:
                    print(f"  - {p}")
                if len(removed) > 10:
                    print(f"  … and {len(removed) - 10} more")
            driver.close()
            return

        if args.embed_only:
            print("Embedding all notes...", file=sys.stderr)
            ensure_vector_index(session, args.verbose)
            notes = collect_notes(wiki_dir, vault_root, ignore_patterns)
            n = embed_notes(session, notes, args.verbose)
            print(f"Embedded {n}/{len(notes)} notes into '{EMBED_INDEX}'.")
            driver.close()
            return

        if args.gds:
            print("Running GDS (projection + community/betweenness/degree)...", file=sys.stderr)
            drop_and_project(session, args.verbose)
            cc = run_leiden(session, args.verbose)
            run_betweenness(session, args.verbose)
            run_degree(session, args.verbose)
            run_wcc(session, args.verbose)
            print(f"GDS complete: {cc} communities, projection 'vault' ready.")
            driver.close()
            return

        if args.discover_only:
            print("Running GDS algorithms...", file=sys.stderr)
            node_count, rel_count = drop_and_project(session, args.verbose)
            community_count = run_leiden(session, args.verbose)
            hubs = run_betweenness(session, args.verbose)
            run_degree(session, args.verbose)
            orphans = run_wcc(session, args.verbose)
            aa_pairs = run_adamic_adar(session, args.verbose)
            jac_pairs = run_jaccard(session, args.verbose)
            paths = run_pathfinding(session, args.verbose)
            communities = get_communities(session)
            stats = get_graph_stats(session)

            try:
                structural_similarity = run_fastrp_knn(session)
            except Exception as e:
                print(f"  WARN: FastRP+KNN failed, skipping: {e}", file=sys.stderr)
                structural_similarity = []

            discovery = {
                "stats": stats,
                "community_count": community_count,
                "hubs": hubs,
                "orphans": orphans,
                "adamic_adar": aa_pairs,
                "jaccard": jac_pairs,
                "paths": paths,
                "communities": communities,
                "structural_similarity": structural_similarity,
            }

            report_path = write_discovery_report(vault_root, discovery)
            print(f"\nDiscovery report written: {report_path}")
            print(json.dumps(discovery, indent=2, default=str))
            driver.close()
            return

        # --- Full sync ---
        print(f"Collecting notes from {wiki_dir}...", file=sys.stderr if not args.verbose else sys.stderr)
        notes = collect_notes(wiki_dir, vault_root, ignore_patterns)
        slug_index = build_slug_index(notes)

        # remove nodes for files that are now ignored or gone (every sync, self-healing)
        removed = prune_graph(session, vault_root, ignore_patterns, args.verbose)
        if removed:
            print(f"  pruned {len(removed)} ignored/stale node(s)")

        sync_state = load_sync_state(state_path)
        new_state = {}
        changed_notes = []

        for note in notes:
            full_path = str(vault_root / note["path"])
            mtime = str(os.path.getmtime(full_path))
            new_state[note["path"]] = mtime
            if sync_state.get(note["path"]) != mtime:
                changed_notes.append(note)

        skipped = len(notes) - len(changed_notes)
        print(f"  {len(notes)} notes found, {len(changed_notes)} changed, {skipped} unchanged")

        if not changed_notes:
            print("Nothing to sync.")
            save_sync_state(state_path, new_state)
            driver.close()
            return

        print(f"Upserting {len(changed_notes)} nodes...")
        upsert_nodes(session, changed_notes, args.verbose)

        print("Upserting edges...")
        edge_counts = upsert_edges(session, changed_notes, slug_index, args.verbose)

        if not args.no_embed:
            print(f"Embedding {len(changed_notes)} changed notes...")
            ensure_vector_index(session, args.verbose)
            embedded = embed_notes(session, changed_notes, args.verbose)
            print(f"  {embedded}/{len(changed_notes)} embedded")

        save_sync_state(state_path, new_state)

        stats = get_graph_stats(session)
        print(
            f"\nSync complete."
            f"\n  Total nodes in DB : {stats['nodes']}"
            f"\n  Total edges in DB : {stats['edges']}"
            f"\n  RELATED_TO        : {stats['related_to']}"
            f"\n  LINKS_TO          : {stats['links_to']}"
            f"\n  AUTHORED_BY       : {stats['authored_by']}"
            f"\n  Unresolved links  : {edge_counts['unresolved']}"
        )

    driver.close()


if __name__ == "__main__":
    main()
