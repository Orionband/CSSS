const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createTestApp } = require('../helpers/testApp');

describe('app smoke', () => {
    let ctx;

    afterEach(async () => {
        if (ctx) {
            await ctx.close();
            ctx = null;
        }
    });

    it('starts and serves /health with dependency checks', async () => {
        ctx = createTestApp();
        const res = await request(ctx.app).get('/health');
        assert.equal(res.status, 200);
        assert.equal(res.body.status, 'ok');
        assert.equal(res.body.checks.database, true);
        assert.equal(res.body.checks.workerPool, true);
    });

    it('health stays ok when the grader queue is saturated', async () => {
        ctx = createTestApp(null, {
            graderPool: {
                poolSize: 4,
                getPendingCount: () => 999,
                shutdown: () => {},
            },
        });
        const res = await request(ctx.app).get('/health');
        assert.equal(res.status, 200);
        assert.equal(res.body.status, 'ok');
        assert.equal(res.body.checks.workerPool, true);
    });
});
