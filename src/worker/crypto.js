const twofish = require('twofish').twofish();

const ZERO_BLOCK_ARR = new Array(16).fill(0);

/** Fixed key (16 × 0x89): CMAC(key, 0, iv) and CMAC(key, 1, empty) — never change. */
const PKT_N_TAG = Buffer.from([174, 205, 199, 88, 167, 8, 145, 254, 184, 198, 109, 78, 22, 51, 20, 93]);
const PKT_H_TAG = Buffer.from([70, 126, 54, 241, 72, 164, 250, 159, 199, 164, 190, 4, 84, 111, 92, 172]);

const xor = (a, b) => {
    const len = a.length;
    const res = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) res[i] = a[i] ^ b[i];
    return res;
};

const xor16Into = (out, a, b) => {
    for (let i = 0; i < 16; i++) out[i] = a[i] ^ b[i];
    return out;
};

const cmac = (key, type, data) => {
    const tfKey = Array.from(key);
    const L = Buffer.from(twofish.encrypt(tfKey, ZERO_BLOCK_ARR));
    const dbl = (v) => {
        const res = Buffer.allocUnsafe(16);
        let carry = 0;
        for (let i = 15; i >= 0; i--) {
            const b = (v[i] << 1) | carry;
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
    const xorIn = new Array(16);
    const padded = Buffer.alloc(16, 0);
    const tmpXor = Buffer.allocUnsafe(16);

    for (let i = 0; i < nBlocks; i++) {
        let block;
        if (i === 0) {
            block = header;
        } else {
            const start = (i - 1) * 16;
            const end = start + 16;
            block = end > data.length ? data.subarray(start) : data.subarray(start, end);
        }
        if (block.length === 16) {
            if (i === nBlocks - 1) {
                xor16Into(tmpXor, block, K1);
                block = tmpXor;
            }
            xor16Into(xorIn, state, block);
            state = Buffer.from(twofish.encrypt(tfKey, xorIn));
        } else {
            padded.fill(0);
            block.copy(padded);
            padded[block.length] = 0x80;
            xor16Into(tmpXor, padded, K2);
            xor16Into(xorIn, state, tmpXor);
            state = Buffer.from(twofish.encrypt(tfKey, xorIn));
        }
    }
    return state;
};

const decryptCTR = (key, iv, ciphertext) => {
    const decrypted = Buffer.allocUnsafe(ciphertext.length);
    const counter = Buffer.from(iv);
    const cipherLen = ciphertext.length;
    const tfKey = Array.from(key);
    const ctrArr = Array.from(counter);

    for (let i = 0; i < cipherLen; i += 16) {
        const k = twofish.encrypt(tfKey, ctrArr);
        const lim = Math.min(16, cipherLen - i);
        for (let j = 0; j < lim; j++) decrypted[i + j] = ciphertext[i + j] ^ k[j];
        for (let j = 15; j >= 0; j--) {
            counter[j] = (counter[j] + 1) & 0xFF;
            ctrArr[j] = counter[j];
            if (counter[j] !== 0) break;
        }
    }
    return decrypted;
};

module.exports = { xor, cmac, decryptCTR, PKT_N_TAG, PKT_H_TAG };
