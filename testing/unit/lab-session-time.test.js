const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    TIME_LIMIT_GRACE_SECONDS,
    isTimeExpired,
    getTimeRemainingSeconds,
} = require('../../src/services/labSessionService');

describe('lab session time limits', () => {
    function timestampSecondsAgo(seconds) {
        const d = new Date(Date.now() - seconds * 1000);
        return d.toISOString().replace('T', ' ').slice(0, 19);
    }

    it('is not expired at exactly the configured limit', () => {
        const ts = timestampSecondsAgo(20 * 60);
        assert.equal(isTimeExpired(ts, 20), false);
    });

    it('is expired after limit plus grace', () => {
        const ts = timestampSecondsAgo(20 * 60 + TIME_LIMIT_GRACE_SECONDS + 1);
        assert.equal(isTimeExpired(ts, 20), true);
    });

    it('getTimeRemainingSeconds includes grace at the exact limit boundary', () => {
        const ts = timestampSecondsAgo(20 * 60);
        assert.equal(getTimeRemainingSeconds(ts, 20), TIME_LIMIT_GRACE_SECONDS);
    });

    it('getTimeRemainingSeconds returns null when no limit', () => {
        assert.equal(getTimeRemainingSeconds(timestampSecondsAgo(10), 0), null);
    });
});
