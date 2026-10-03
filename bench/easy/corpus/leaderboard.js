function topScores(results, n = 3) {
  const scores = results
    .filter((r) => Number.isFinite(r.score))
    .map((r) => r.score);
  scores.sort();
  scores.reverse();
  return scores.slice(0, n);
}

function rankPlayers(results) {
  const best = new Map();
  for (const r of results) {
    if (!Number.isFinite(r.score)) continue;
    const prev = best.get(r.player);
    if (prev === undefined || r.score > prev) best.set(r.player, r.score);
  }
  return [...best.entries()]
    .map(([player, score]) => ({ player, score }))
    .sort((a, b) => b.score - a.score || a.player.localeCompare(b.player));
}

module.exports = { topScores, rankPlayers };
