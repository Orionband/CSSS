const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    parsePagination,
    resolveUploadMb,
    maxUploadMbFromLabs,
    getConfigNumber,
    ensureArray,
    MAX_LIMIT,
} = require('../../src/limits');

describe('limits', () => {
    it('parsePagination applies defaults and clamps limit', () => {
        assert.deepEqual(parsePagination({}), { limit: 100, offset: 0 });
        assert.deepEqual(parsePagination({ limit: '9999', offset: '5' }), { limit: MAX_LIMIT, offset: 5 });
        assert.deepEqual(parsePagination({ limit: '-1', offset: '-3' }), { limit: 100, offset: 0 });
    });

    it('resolveUploadMb falls back on invalid input', () => {
        assert.equal(resolveUploadMb(undefined, 60), 60);
        assert.equal(resolveUploadMb('abc', 60), 60);
        assert.equal(resolveUploadMb(25, 60), 25);
    });

    it('maxUploadMbFromLabs picks highest lab cap', () => {
        const max = maxUploadMbFromLabs([
            { max_upload_mb: 10 },
            { max_upload_mb: 80 },
            {},
        ]);
        assert.equal(max, 80);
    });

    it('getConfigNumber floors valid positive numbers', () => {
        assert.equal(getConfigNumber(4.9, 2), 4);
        assert.equal(getConfigNumber(0, 2), 2);
        assert.equal(getConfigNumber('nope', 7), 7);
    });

    it('ensureArray wraps non-arrays', () => {
        assert.deepEqual(ensureArray([1]), [1]);
        assert.deepEqual(ensureArray(null), []);
        assert.deepEqual(ensureArray('x'), []);
    });
});
