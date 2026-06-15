const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { parseDbTimestamp, elapsedSecondsSince, chartTimeMs } = require('../../src/submissionDuration');

describe('submissionDuration', () => {
    it('parseDbTimestamp treats SQLite datetime as UTC', () => {
        const ms = parseDbTimestamp('2024-06-01 12:00:00');
        assert.equal(ms, Date.parse('2024-06-01T12:00:00Z'));
    });

    describe('elapsedSecondsSince', () => {
        let originalNow;

        beforeEach(() => {
            originalNow = Date.now;
        });

        afterEach(() => {
            Date.now = originalNow;
        });

        it('returns floored elapsed seconds', () => {
            const start = '2024-06-01 12:00:00';
            Date.now = () => parseDbTimestamp(start) + 5500;
            assert.equal(elapsedSecondsSince(start), 5);
        });

        it('never returns negative elapsed time', () => {
            const start = '2024-06-01 12:00:00';
            Date.now = () => parseDbTimestamp(start) - 1000;
            assert.equal(elapsedSecondsSince(start), 0);
        });
    });

    it('chartTimeMs uses base time for stream polls', () => {
        const base = parseDbTimestamp('2024-06-01 12:00:00');
        assert.equal(chartTimeMs({ timestamp: '2024-06-01 12:00:00', stream_poll: 1 }), base);
    });

    it('chartTimeMs adds duration for completed submissions', () => {
        const base = parseDbTimestamp('2024-06-01 12:00:00');
        assert.equal(chartTimeMs({ timestamp: '2024-06-01 12:00:00', duration_seconds: 30 }), base + 30000);
    });
});
