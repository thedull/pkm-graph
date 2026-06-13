// Node Similarity (Jaccard) — pages with high neighbor overlap
CALL gds.nodeSimilarity.stream('vault', {
  similarityCutoff: 0.4,
  topK: 10
})
YIELD node1, node2, similarity
WITH gds.util.asNode(node1) AS a, gds.util.asNode(node2) AS b, similarity
WHERE a.title < b.title
  AND NOT (a)-[:RELATED_TO]-(b)
RETURN a.title AS pageA, a.type AS typeA,
       b.title AS pageB, b.type AS typeB,
       round(similarity, 4) AS similarity
ORDER BY similarity DESC
LIMIT 30;
