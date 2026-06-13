// Leiden community detection — writes community_id to each node
CALL gds.leiden.write('vault', {
  writeProperty: 'community_id',
  randomSeed: 42,
  gamma: 1.0
}) YIELD communityCount, modularity;

// Inspect communities
MATCH (n:WikiPage)
WITH n.community_id AS cid, collect(n.title) AS members, count(*) AS size
WHERE size >= 3
RETURN cid, size, members[..8] AS sample
ORDER BY size DESC
LIMIT 15;
