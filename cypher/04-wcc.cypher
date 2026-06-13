// Weakly Connected Components — finds orphaned clusters
CALL gds.wcc.write('vault', {
  writeProperty: 'component'
}) YIELD componentCount, componentDistribution;

// Small isolated components (not the main giant component)
MATCH (n:WikiPage)
WITH n.component AS cid, collect(n.title) AS members, count(*) AS size
WHERE size < 10
RETURN cid, size, members
ORDER BY size ASC
LIMIT 20;

// Main component size
MATCH (n:WikiPage)
WITH n.component AS cid, count(*) AS size
RETURN cid, size
ORDER BY size DESC
LIMIT 1;
