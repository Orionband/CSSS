const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createTestApp, loginAgent, getCsrfToken } = require('../helpers/testApp');
const { fixtureConfig } = require('../helpers/fixtures');

const oneAttemptLabConfig = {
    labs: [{
        ...fixtureConfig.labs[0],
        id: 'onelab',
        max_submissions: 1,
    }],
    quizzes: fixtureConfig.quizzes,
};

async function concurrentLabStarts(agent, labId, count = 3) {
    const csrf = await getCsrfToken(agent);
    const headers = { 'x-csrf-token': csrf };
    return Promise.all(
        Array.from({ length: count }, () =>
            agent.post(`/api/lab/${labId}/start`).set(headers).send({})
        )
    );
}

function activeLabCount(db, userId, labId) {
    return db.prepare(
        "SELECT COUNT(*) AS c FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'lab'"
    ).get(userId, labId).c;
}

describe('lab start race', () => {
    let ctx;
    let agent;

    beforeEach(async () => {
        ctx = createTestApp();
        agent = request.agent(ctx.app);
        await loginAgent(agent, 'student', 'student-pass-1');
    });

    afterEach(async () => {
        if (ctx) await ctx.close();
    });

    it('creates only one in_progress row when start requests run concurrently', async () => {
        const results = await concurrentLabStarts(agent, 'testlab');

        for (const res of results) {
            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
        }

        assert.equal(activeLabCount(ctx.db, ctx.users.student.id, 'testlab'), 1);

        const resumedFlags = results.map((res) => res.body.resumed);
        assert.equal(resumedFlags.filter((v) => v === false).length, 1);
        assert.equal(resumedFlags.filter((v) => v === true).length, results.length - 1);
    });
});

describe('lab start race with max_submissions=1', () => {
    let ctx;
    let agent;

    beforeEach(async () => {
        ctx = createTestApp(oneAttemptLabConfig);
        agent = request.agent(ctx.app);
        await loginAgent(agent, 'student', 'student-pass-1');
    });

    afterEach(async () => {
        if (ctx) await ctx.close();
    });

    it('allows only one in_progress row under concurrent starts', async () => {
        const results = await concurrentLabStarts(agent, 'onelab');

        for (const res of results) {
            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
        }

        assert.equal(activeLabCount(ctx.db, ctx.users.student.id, 'onelab'), 1);

        const totalAttempts = ctx.db.prepare(
            'SELECT COUNT(*) AS c FROM submissions WHERE user_id = ? AND lab_id = ? AND COALESCE(stream_poll, 0) = 0'
        ).get(ctx.users.student.id, 'onelab').c;
        assert.equal(totalAttempts, 1);
    });

    it('rejects concurrent starts when max_submissions is already reached', async () => {
        ctx.db.prepare(
            "INSERT INTO submissions (user_id, unique_id, lab_id, score, max_score, status, type) VALUES (?, ?, ?, 0, 0, 'completed', 'lab')"
        ).run(ctx.users.student.id, ctx.users.student.unique_id, 'onelab');

        const results = await concurrentLabStarts(agent, 'onelab');

        for (const res of results) {
            assert.equal(res.status, 403);
            assert.match(res.body.error, /maximum attempts reached/i);
        }

        assert.equal(activeLabCount(ctx.db, ctx.users.student.id, 'onelab'), 0);
    });
});
