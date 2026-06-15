const { describe, it, after, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createTestApp, loginAgent, getCsrfToken } = require('../helpers/testApp');

describe('CSRF enforcement', () => {
    let ctx;
    let agent;

    before(async () => {
        ctx = createTestApp();
        agent = request.agent(ctx.app);
        await loginAgent(agent, 'student', 'student-pass-1');
    });

    after(async () => {
        if (ctx) await ctx.close();
    });

    it('allows GET /api/csrf-token without CSRF header', async () => {
        const res = await request(ctx.app).get('/api/csrf-token');
        assert.equal(res.status, 200);
        assert.ok(res.body.csrfToken);
    });

    it('rejects POST /api/logout without CSRF token', async () => {
        const res = await agent.post('/api/logout').send({});
        assert.equal(res.status, 403);
    });

    it('rejects POST /api/lab/:id/start without CSRF token', async () => {
        const res = await agent.post('/api/lab/testlab/start').send({});
        assert.equal(res.status, 403);
    });

    it('rejects POST /api/quiz/:id/start without CSRF token', async () => {
        const res = await agent.post('/api/quiz/testquiz/start').send({});
        assert.equal(res.status, 403);
    });

    it('rejects POST /api/admin/users without CSRF token', async () => {
        const adminAgent = request.agent(ctx.app);
        await loginAgent(adminAgent, 'admin', 'admin-pass-1');
        const res = await adminAgent.post('/api/admin/users').send({
            username: 'x', email: 'x@test.local', password: 'long-password-1',
        });
        assert.equal(res.status, 403);
    });

    it('allows state-changing routes with valid CSRF token', async () => {
        const csrf = await getCsrfToken(agent);
        const res = await agent
            .post('/api/lab/testlab/start')
            .set('x-csrf-token', csrf)
            .send({});
        assert.equal(res.status, 200);
        assert.equal(res.body.success, true);
    });
});
