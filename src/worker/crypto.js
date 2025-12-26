const twofish = require('twofish').twofish();
const xor = (a, b) => {
    const len = a.length;
    const res = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) res[i] = a[i] ^ b[i];
    return res;
};
const cmac = (key, type, data) => {
    const tfKey = Array.from(key);
    const L = Buffer.from(twofish.encrypt(tfKey, Array.from(Buffer.alloc(16, 0))));
    const dbl = (v) => {
        let res = Buffer.allocUnsafe(16);
        let carry = 0;
        for (let i = 15; i >= 0; i--) {
            let b = (v[i] << 1) | carry;
            res[i] = b & 0xff;
            carry = (v[i] >> 7) & 1;
        }
        if (v[0] >> 7) res[15] ^= 0x87;
        return res;
    };
    const K1 = dbl(L);
    const K2 = dbl(K1);
    const header = Buffer.alloc(16, 0);
    header[15] = type;
    const nBlocks = Math.ceil((16 + data.length) / 16);
    let state = Buffer.alloc(16, 0);
    for (let i = 0; i < nBlocks; i++) {
        let block;
        if (i === 0) block = header;
        else {
            const start = (i - 1) * 16;
            const end = start + 16;
            block = (end > data.length) ? data.subarray(start) : data.subarray(start, end);
        }
        if (block.length === 16) {
            if (i === nBlocks - 1) block = xor(block, K1);
            state = Buffer.from(twofish.encrypt(tfKey, Array.from(xor(state, block))));
        } else {
            const padded = Buffer.alloc(16, 0);
            block.copy(padded);
            padded[block.length] = 0x80;
            state = Buffer.from(twofish.encrypt(tfKey, Array.from(xor(state, xor(padded, K2)))));
        }
    }
    return state;
};
const decryptCTR = (key, iv, ciphertext) => {
    let decrypted = Buffer.allocUnsafe(ciphertext.length);
    let counter = Buffer.from(iv);
    const cipherLen = ciphertext.length;
    for (let i = 0; i < cipherLen; i += 16) {
        const k = Buffer.from(twofish.encrypt(Array.from(key), Array.from(counter)));
        const lim = Math.min(16, cipherLen - i);
        for (let j = 0; j < lim; j++) decrypted[i + j] = ciphertext[i + j] ^ k[j];
        for (let j = 15; j >= 0; j--) { counter[j] = (counter[j] + 1) & 0xFF; if (counter[j] !== 0) break; }
    }
    return decrypted;
};
module.exports = { xor, cmac, decryptCTR };
