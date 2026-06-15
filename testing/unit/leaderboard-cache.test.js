const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { getCachedLeaderboard, invalidateLeaderboardCache } = require('../../src/leaderboardCache');

describe('leaderboardCache', () => {
    beforeEach(() => {
        invalidateLeaderboardCache();
    });

    it('reuses cached leaderboard until invalidated', () => {
        let builds = 0;
        const build = () => ({ builds: ++builds });

        assert.equal(getCachedLeaderboard(build).builds, 1);
        assert.equal(getCachedLeaderboard(build).builds, 1);

        invalidateLeaderboardCache();
        assert.equal(getCachedLeaderboard(build).builds, 2);
    });
});
