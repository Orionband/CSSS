const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validatePasswordPolicy, passwordUtf8ByteLength, BCRYPT_MAX_PASSWORD_BYTES } = require('../../src/passwordPolicy');

describe('passwordPolicy', () => {
    it('accepts a valid password', () => {
        const result = validatePasswordPolicy('Secure1!');
        assert.equal(result.ok, true);
    });

    it('rejects short passwords', () => {
        const result = validatePasswordPolicy('Ab1!');
        assert.equal(result.ok, false);
        assert.match(result.error, /8 characters/);
    });

    it('rejects passwords without uppercase', () => {
        const result = validatePasswordPolicy('secure1!');
        assert.equal(result.ok, false);
        assert.match(result.error, /uppercase/);
    });

    it('rejects passwords without a number', () => {
        const result = validatePasswordPolicy('Secure!!');
        assert.equal(result.ok, false);
        assert.match(result.error, /number/);
    });

    it('rejects passwords without a symbol', () => {
        const result = validatePasswordPolicy('Secure12');
        assert.equal(result.ok, false);
        assert.match(result.error, /symbol/);
    });

    it('rejects passwords over bcrypt byte limit', () => {
        const long = 'A1!' + 'x'.repeat(BCRYPT_MAX_PASSWORD_BYTES);
        assert.ok(passwordUtf8ByteLength(long) > BCRYPT_MAX_PASSWORD_BYTES);
        const result = validatePasswordPolicy(long);
        assert.equal(result.ok, false);
        assert.match(result.error, /72 bytes/);
    });
});
