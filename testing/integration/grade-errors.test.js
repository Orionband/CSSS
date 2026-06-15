const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runGrade, sanitizeErrorMessage } = require('../../src/worker/gradeJob');

describe('grade error paths', () => {
    it('rejects plain XML as integrity failure', async () => {
        const buf = Buffer.from('<?xml version="1.0"?><root/>');
        await assert.rejects(
            () => runGrade({ fileBuffer: buf, labConfig: { checks: [] } }, () => {}),
            (err) => {
                assert.match(sanitizeErrorMessage(err.message), /integrity check failed/i);
                return true;
            },
        );
    });

    it('rejects random bytes', async () => {
        const buf = Buffer.alloc(256, 0xAB);
        await assert.rejects(
            () => runGrade({ fileBuffer: buf, labConfig: { checks: [] } }, () => {}),
            (err) => {
                assert.ok(err.message);
                return true;
            },
        );
    });

    it('throws when lab config is missing', async () => {
        await assert.rejects(
            () => runGrade({ fileBuffer: Buffer.from('data') }, () => {}),
            /Lab configuration not found/i,
        );
    });
});
