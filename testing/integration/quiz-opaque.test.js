const { describe, it, after, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createTestApp, loginAgent, getCsrfToken } = require('../helpers/testApp');

describe('quiz opaque answer IDs', () => {
    let ctx;
    let agent;
    before(async () => {
        ctx = createTestApp();
        agent = request.agent(ctx.app);
        await loginAgent(agent, 'student', 'student-pass-1');
        const csrf = await getCsrfToken(agent);
        const startRes = await agent.post('/api/quiz/testquiz/start').set('x-csrf-token', csrf).send({});
        assert.equal(startRes.status, 200);
        const question = startRes.body.questions[0];
        assert.ok(question.answers[0].id);
        assert.notEqual(question.answers[0].id, '0');
    });

    after(async () => {
        if (ctx) await ctx.close();
    });

    it('scores zero when submitting wrong opaque id', async () => {
        const csrf = await getCsrfToken(agent);
        const res = await agent
            .post('/api/quiz/testquiz/submit')
            .set('x-csrf-token', csrf)
            .send({ answers: { 0: 'deadbeef' } });
        assert.equal(res.status, 200);
        assert.equal(res.body.score, 0);
    });

    it('scores points when submitting correct opaque id', async () => {
        const csrfStart = await getCsrfToken(agent);
        const startRes = await agent.post('/api/quiz/testquiz/start').set('x-csrf-token', csrfStart).send({});
        assert.equal(startRes.status, 200);
        const correctOpaqueId = startRes.body.questions[0].answers[0].id;
        const csrf = await getCsrfToken(agent);
        const res = await agent
            .post('/api/quiz/testquiz/submit')
            .set('x-csrf-token', csrf)
            .send({ answers: { 0: correctOpaqueId } });
        assert.equal(res.status, 200);
        assert.equal(res.body.score, 1);
    });
});
