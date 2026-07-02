const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { timingSafeEqualStrings } = require('../../src/secureCompare');

describe('timingSafeEqualStrings', () => {
    it('returns true for equal strings', () => {
        const token = 'a'.repeat(64);
        assert.equal(timingSafeEqualStrings(token, token), true);
    });

    it('returns false for different strings of equal length', () => {
        const a = 'a'.repeat(64);
        const b = 'b'.repeat(64);
        assert.equal(timingSafeEqualStrings(a, b), false);
    });

    it('returns false for different lengths', () => {
        assert.equal(timingSafeEqualStrings('short', 'longer'), false);
    });

    it('returns false for non-string inputs', () => {
        assert.equal(timingSafeEqualStrings(null, 'token'), false);
        assert.equal(timingSafeEqualStrings('token', undefined), false);
    });
});
