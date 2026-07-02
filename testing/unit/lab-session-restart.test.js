const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createDatabase } = require('../../src/database');
const {
    createLabSessionService,
    isTimeLimitAutoClosedDetails,
} = require('../../src/services/labSessionService');
const { createTestApp, loginAgent, getCsrfToken } = require('../helpers/testApp');

describe('lab session restart after time limit', () => {
    let db;

    beforeEach(() => {
        db = createDatabase(':memory:', { silentChmod: true, skipStaleLockClear: true });
        db.prepare('INSERT INTO users (username, email, password, unique_id) VALUES (?, ?, ?, ?)')
            .run('student', 'student@test.local', 'hash', 'UID-0001');
    });

    afterEach(() => {
        if (db?.closeDatabase) db.closeDatabase();
    });

    it('detects time-limit auto-close details for lab and quiz formats', () => {
        const labAutoClose = JSON.stringify([{
            message: 'Auto-closed: Time limit expired.',
            device: 'N/A',
            possible: 0,
            awarded: 0,
            passed: false,
        }]);
        const quizAutoClose = JSON.stringify([{ message: 'Time expired', correct: false }]);
        const quizSubmitRejected = JSON.stringify([{ message: 'Submission rejected: Time limit expired.', correct: false }]);

        assert.equal(isTimeLimitAutoClosedDetails(labAutoClose), true);
        assert.equal(isTimeLimitAutoClosedDetails(quizAutoClose), true);
        assert.equal(isTimeLimitAutoClosedDetails(quizSubmitRejected), true);
        assert.equal(isTimeLimitAutoClosedDetails(JSON.stringify([{ message: 'Auto-closed: Competition window ended.', passed: false }])), false);
        assert.equal(isTimeLimitAutoClosedDetails(JSON.stringify([{ message: 'hostname ok', passed: true }])), false);
    });

    it('blocks a new lab start after time-limit auto-close when attempts are unlimited', () => {
        const service = createLabSessionService(db);
        db.prepare(`
            INSERT INTO submissions (user_id, unique_id, lab_id, score, max_score, type, status, details)
            VALUES (1, 'UID-0001', 'timedlab', 0, 0, 'lab', 'completed', ?)
        `).run(JSON.stringify([{
            message: 'Auto-closed: Time limit expired.',
            device: 'N/A',
            possible: 0,
            awarded: 0,
            passed: false,
        }]));

        assert.equal(service.isRestartBlockedAfterTimeLimit(1, 'timedlab', 30, 0), true);
        assert.equal(service.isRestartBlockedAfterTimeLimit(1, 'timedlab', 30, 5), false);
        assert.equal(service.isRestartBlockedAfterTimeLimit(1, 'timedlab', 0, 0), false);
    });

    it('standalone isRestartBlockedAfterTimeLimit matches service wrapper argument order', () => {
        const { isRestartBlockedAfterTimeLimit } = require('../../src/services/labSessionService');
        const details = JSON.stringify([{ message: 'Time expired', correct: false }]);
        db.prepare(`
            INSERT INTO submissions (user_id, unique_id, lab_id, score, max_score, type, status, details)
            VALUES (1, 'UID-0001', 'quiz1', 0, 0, 'quiz', 'completed', ?)
        `).run(details);

        assert.equal(
            isRestartBlockedAfterTimeLimit(db, 1, 'quiz1', 30, 0, 'quiz'),
            true,
        );
    });

    it('returns permanent time-limit error when closing expired unlimited-attempt lab on start', async () => {
        const config = {
            labs: [{
                id: 'timedlab',
                title: 'Timed Lab',
                max_submissions: 0,
                time_limit_minutes: 30,
                checks: [],
            }],
            quizzes: [],
        };
        const ctx = createTestApp(config);
        try {
            const agent = request.agent(ctx.app);
            await loginAgent(agent, 'student', 'student-pass-1');

            const past = new Date(Date.now() - 31 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
            ctx.db.prepare(`
                INSERT INTO submissions (user_id, unique_id, lab_id, type, status, timestamp)
                VALUES (?, ?, 'timedlab', 'lab', 'in_progress', ?)
            `).run(ctx.users.student.id, ctx.users.student.unique_id, past);

            const csrf = await getCsrfToken(agent);
            const res = await agent
                .post('/api/lab/timedlab/start')
                .set('x-csrf-token', csrf)
                .send({});

            assert.equal(res.status, 403);
            assert.equal(res.body.error, 'Time limit expired for this lab.');
        } finally {
            await ctx.close();
        }
    });

    it('blocks restart when a stream poll shadows the time-limit close row', () => {
        const service = createLabSessionService(db);
        const timeLimitClose = JSON.stringify([{
            message: 'Auto-closed: Time limit expired.',
            device: 'N/A',
            possible: 0,
            awarded: 0,
            passed: false,
        }]);
        const streamPollDetails = JSON.stringify([{
            message: 'hostname ok',
            device: 'R1',
            possible: 10,
            awarded: 5,
            passed: false,
        }]);

        db.prepare(`
            INSERT INTO submissions (id, user_id, unique_id, lab_id, type, status, time_limit_closed)
            VALUES (1, 1, 'UID-0001', 'timedlab', 'lab', 'completed', 1)
        `).run();
        db.prepare('UPDATE submissions SET details = ? WHERE id = 1').run(timeLimitClose);

        db.prepare(`
            INSERT INTO submissions (id, user_id, unique_id, lab_id, score, max_score, type, status, details, stream_poll)
            VALUES (2, 1, 'UID-0001', 'timedlab', 5, 10, 'lab', 'completed', ?, 1)
        `).run(streamPollDetails);

        assert.equal(service.isRestartBlockedAfterTimeLimit(1, 'timedlab', 30, 0), true);
    });

    it('blocks restart using time_limit_closed without relying on details text', () => {
        const service = createLabSessionService(db);
        db.prepare(`
            INSERT INTO submissions (user_id, unique_id, lab_id, score, max_score, type, status, details, time_limit_closed)
            VALUES (1, 'UID-0001', 'timedlab', 0, 0, 'lab', 'completed', ?, 1)
        `).run(JSON.stringify([{ message: 'Any future wording.', passed: false }]));

        assert.equal(service.isRestartBlockedAfterTimeLimit(1, 'timedlab', 30, 0), true);
    });

    it('rejects POST /api/lab/:id/start after sweeper-style time-limit closure', async () => {
        const config = {
            labs: [{
                id: 'timedlab',
                title: 'Timed Lab',
                max_submissions: 0,
                time_limit_minutes: 30,
                checks: [],
            }],
            quizzes: [],
        };
        const ctx = createTestApp(config);
        try {
            const agent = request.agent(ctx.app);
            await loginAgent(agent, 'student', 'student-pass-1');

            ctx.db.prepare(`
                INSERT INTO submissions (user_id, unique_id, lab_id, score, max_score, type, status, details)
                VALUES (?, ?, 'timedlab', 0, 0, 'lab', 'completed', ?)
            `).run(
                ctx.users.student.id,
                ctx.users.student.unique_id,
                JSON.stringify([{
                    message: 'Auto-closed: Time limit expired.',
                    device: 'N/A',
                    possible: 0,
                    awarded: 0,
                    passed: false,
                }]),
            );

            const csrf = await getCsrfToken(agent);
            const res = await agent
                .post('/api/lab/timedlab/start')
                .set('x-csrf-token', csrf)
                .send({});

            assert.equal(res.status, 403);
            assert.match(res.body.error, /Time limit expired/i);
        } finally {
            await ctx.close();
        }
    });
});
