// Betweenness centrality — writes betweenness to each node
CALL gds.betweenness.write('vault', {
  writeProperty: 'betweenness'
}) YIELD minimumScore, maximumScore, meanScore, nodePropertiesWritten;

// Top hub concepts (bridge nodes between clusters)
MATCH (n:WikiPage)
WHERE n.betweenness IS NOT NULL
RETURN n.title, n.type, round(n.betweenness, 2) AS score
ORDER BY score DESC
LIMIT 20;
