const CACHE_TTL_MS = parseInt(process.env.LEADERBOARD_CACHE_TTL_MS, 10) || 45000;

let cache = null;

function getCachedLeaderboard(buildFn) {
    const now = Date.now();
    if (cache && cache.expiresAt > now) {
        return cache.data;
    }
    const data = buildFn();
    cache = { data, expiresAt: now + CACHE_TTL_MS };
    return data;
}

function invalidateLeaderboardCache() {
    cache = null;
}

module.exports = { getCachedLeaderboard, invalidateLeaderboardCache, CACHE_TTL_MS };
