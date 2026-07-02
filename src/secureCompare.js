const crypto = require('crypto');

function timingSafeEqualStrings(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const aBuf = Buffer.from(a);
    const bBuf = Buffer.from(b);
    if (aBuf.length !== bBuf.length) return false;
    try {
        return crypto.timingSafeEqual(aBuf, bBuf);
    } catch {
        return false;
    }
}

module.exports = { timingSafeEqualStrings };
