// Adamic-Adar link prediction — pairs that should be connected but aren't
CALL gds.linkprediction.adamicAdar.stream('vault', {
  relationshipTypes: ['RELATED_TO'],
  topK: 50
})
YIELD node1, node2, similarity
WITH gds.util.asNode(node1) AS a, gds.util.asNode(node2) AS b, similarity
WHERE similarity > 2.0
  AND NOT (a)-[:RELATED_TO]-(b)
RETURN a.title AS pageA, a.type AS typeA,
       b.title AS pageB, b.type AS typeB,
       round(similarity, 3) AS score
ORDER BY score DESC
LIMIT 30;
