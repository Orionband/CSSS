/**
 * Cached Twofish key schedule for Packet Tracer decrypt (CMAC + CTR keystream).
 * Uses the in-repo vendor copy in vendor/twofish-core.js — not node_modules.
 */
const tfFactory = require('./vendor/twofish-core').twofish;
const tf = tfFactory();

const expandKeyFn = tf._expandKey;
const blockEncryptFn = tf._blockEncrypt;

if (typeof expandKeyFn !== 'function' || typeof blockEncryptFn !== 'function') {
    throw new Error('vendor/twofish-core.js must export _expandKey and _blockEncrypt');
}

const expandedKeyCache = new Map();

function expandKey(keyBytes) {
    const cacheKey = Buffer.isBuffer(keyBytes)
        ? keyBytes.toString('hex')
        : Buffer.from(keyBytes).toString('hex');

    if (expandedKeyCache.has(cacheKey)) {
        return expandedKeyCache.get(cacheKey);
    }

    const u8 = keyBytes instanceof Uint8Array ? keyBytes : new Uint8Array(keyBytes);
    const sessionKey = expandKeyFn(u8);
    expandedKeyCache.set(cacheKey, sessionKey);
    return sessionKey;
}

function runTwofishBlock(expandedKey, input16, output16) {
    const inArr = input16 instanceof Uint8Array
        ? input16
        : new Uint8Array(input16.buffer, input16.byteOffset, 16);
    const out = blockEncryptFn(inArr, 0, expandedKey);
    for (let i = 0; i < 16; i++) output16[i] = out[i];
}

const ZERO_BLOCK = Buffer.alloc(16, 0);

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

const dblBlock = (v, out) => {
    let carry = 0;
    for (let i = 15; i >= 0; i--) {
        const b = (v[i] << 1) | carry;
        out[i] = b & 0xff;
        carry = (v[i] >> 7) & 1;
    }
    if (v[0] >> 7) out[15] ^= 0x87;
    return out;
};

const cmac = (key, type, data) => {
    const sessionKey = expandKey(key);
    const L = Buffer.allocUnsafe(16);
    runTwofishBlock(sessionKey, ZERO_BLOCK, L);

    const K1 = Buffer.allocUnsafe(16);
    const K2 = Buffer.allocUnsafe(16);
    dblBlock(L, K1);
    dblBlock(K1, K2);

    const header = Buffer.alloc(16, 0);
    header[15] = type;
    const nBlocks = Math.ceil((16 + data.length) / 16);

    const state = Buffer.alloc(16, 0);
    const xorIn = Buffer.allocUnsafe(16);
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
            runTwofishBlock(sessionKey, xorIn, state);
        } else {
            padded.fill(0);
            block.copy(padded);
            padded[block.length] = 0x80;
            xor16Into(tmpXor, padded, K2);
            xor16Into(xorIn, state, tmpXor);
            runTwofishBlock(sessionKey, xorIn, state);
        }
    }

    return Buffer.from(state);
};

const decryptCTR = (key, iv, ciphertext) => {
    const out = Buffer.allocUnsafe(ciphertext.length);
    decryptCTRWithFinalXor(key, iv, ciphertext, out, false);
    return out;
};

/**
 * CTR decrypt with optional Packet Tracer post-XOR fused into the output loop.
 * When applyFinalXor is true, out[i] = decrypt(cipher[i]) ^ (dLen - i).
 */
const decryptCTRWithFinalXor = (key, iv, ciphertext, out, applyFinalXor = true) => {
    const sessionKey = expandKey(key);
    const counter = Buffer.from(iv);
    const keyStream = Buffer.allocUnsafe(16);
    const cipherLen = ciphertext.length;

    for (let i = 0; i < cipherLen; i += 16) {
        runTwofishBlock(sessionKey, counter, keyStream);

        const lim = Math.min(16, cipherLen - i);
        if (applyFinalXor) {
            for (let j = 0; j < lim; j++) {
                const idx = i + j;
                out[idx] = (ciphertext[idx] ^ keyStream[j] ^ (cipherLen - idx)) & 0xFF;
            }
        } else {
            for (let j = 0; j < lim; j++) {
                out[i + j] = ciphertext[i + j] ^ keyStream[j];
            }
        }

        for (let j = 15; j >= 0; j--) {
            counter[j] = (counter[j] + 1) & 0xFF;
            if (counter[j] !== 0) break;
        }
    }

    return out;
};

module.exports = {
    xor,
    cmac,
    decryptCTR,
    decryptCTRWithFinalXor,
    PKT_N_TAG,
    PKT_H_TAG,
};
