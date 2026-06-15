const { describe, it, after, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createTestApp, loginAgent, getCsrfToken } = require('../helpers/testApp');
const { closedLabConfig } = require('../helpers/fixtures');

describe('lab time-window behavior', () => {
    let ctx;

    after(async () => {
        if (ctx) await ctx.close();
    });

    before(() => {
        ctx = createTestApp(closedLabConfig);
    });

    it('rejects lab start outside competition window', async () => {
        const agent = request.agent(ctx.app);
        await loginAgent(agent, 'student', 'student-pass-1');
        const csrf = await getCsrfToken(agent);
        const res = await agent
            .post('/api/lab/closedlab/start')
            .set('x-csrf-token', csrf)
            .send({});
        assert.equal(res.status, 403);
    });
});
