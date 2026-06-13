// Drop existing projection (safe if not present)
CALL gds.graph.exists('vault') YIELD exists
WITH exists WHERE exists = true
CALL gds.graph.drop('vault') YIELD graphName
RETURN graphName;

// Re-project the vault graph
CALL gds.graph.project(
  'vault',
  'WikiPage',
  {
    RELATED_TO: { orientation: 'UNDIRECTED', properties: ['weight'] },
    LINKS_TO:   { orientation: 'NATURAL',   properties: ['weight'] }
  }
) YIELD nodeCount, relationshipCount;
