// Shortest path between two concepts (Dijkstra weighted)
// Replace $startTitle and $endTitle with actual note titles

MATCH (a:WikiPage {title: $startTitle}), (b:WikiPage {title: $endTitle})
CALL gds.shortestPath.dijkstra.stream('vault', {
  sourceNode: a,
  targetNode: b,
  relationshipWeightProperty: 'weight'
})
YIELD nodeIds, totalCost
RETURN [nid IN nodeIds | gds.util.asNode(nid).title] AS chain,
       totalCost
LIMIT 1;

// Example: Foucault → AI Alignment
// MATCH (a:WikiPage {title: 'Michel Foucault'}), (b:WikiPage {title: 'AI Alignment'})
// ...
