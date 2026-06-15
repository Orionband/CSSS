const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('buffer transfer slice', () => {
    it('slice covers only the buffer view, not the full underlying ArrayBuffer', () => {
        const full = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        const view = full.subarray(4, 8);
        const slice = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
        assert.equal(slice.byteLength, view.byteLength);
        assert.equal(slice.byteLength, 4);
        assert.notEqual(slice.byteLength, full.buffer.byteLength);
    });
});
