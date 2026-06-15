const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
process.env.CSSS_SKIP_ASSET_VALIDATION = 'true';
const { purgeProjectCache } = require('../helpers/purgeCache');
purgeProjectCache();
const { isWindowOpen } = require('../../src/config');
describe('isWindowOpen', () => {
    let originalNow;

    beforeEach(() => {
        originalNow = Date.now;
    });

    afterEach(() => {
        Date.now = originalNow;
    });

    it('returns true when no window dates are set', () => {
        assert.equal(isWindowOpen({}), true);
        assert.equal(isWindowOpen({ comp_start: null, comp_end: null }), true);
    });

    it('returns false before comp_start', () => {
        Date.now = () => Date.parse('2024-01-01T00:00:00Z');
        assert.equal(isWindowOpen({ comp_start: '2024-06-01T00:00:00Z' }), false);
    });

    it('returns false after comp_end', () => {
        Date.now = () => Date.parse('2024-12-01T00:00:00Z');
        assert.equal(isWindowOpen({ comp_end: '2024-06-01T00:00:00Z' }), false);
    });

    it('returns true inside the window', () => {
        Date.now = () => Date.parse('2024-06-15T00:00:00Z');
        assert.equal(isWindowOpen({
            comp_start: '2024-06-01T00:00:00Z',
            comp_end: '2024-07-01T00:00:00Z',
        }), true);
    });

    it('returns false for invalid date strings', () => {
        Date.now = () => Date.parse('2024-06-15T00:00:00Z');
        assert.equal(isWindowOpen({ comp_start: 'not-a-date' }), false);
    });
});
