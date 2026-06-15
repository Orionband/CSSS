const { describe, it, after, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { io: ioClient } = require('socket.io-client');
const { createTestApp, loginAgent, getCsrfToken, SUCCESS_MOCK_POOL } = require('../helpers/testApp');

function connectSocket(port, cookieHeader) {
    return ioClient(`http://127.0.0.1:${port}`, {
        transports: ['websocket'],
        extraHeaders: cookieHeader ? { cookie: cookieHeader } : {},
    });
}

function waitForEvent(socket, event, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
        socket.once(event, (data) => {
            clearTimeout(timer);
            resolve(data);
        });
        socket.once('err', (msg) => {
            clearTimeout(timer);
            reject(new Error(`socket err: ${msg}`));
        });
    });
}

describe('socket upload grading', () => {
    let ctx;
    let port;
    let cookie;
    let csrf;
    let studentId;

    before(async () => {
        ctx = createTestApp(null, { graderPool: SUCCESS_MOCK_POOL });
        const agent = request.agent(ctx.app);
        const loginRes = await loginAgent(agent, 'student', 'student-pass-1');
        assert.equal(loginRes.status, 200);
        csrf = loginRes.body.csrfToken || (await getCsrfToken(agent));
        studentId = ctx.users.student.id;
        const setCookie = loginRes.headers['set-cookie'];
        if (Array.isArray(setCookie)) {
            cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
        } else if (setCookie) {
            cookie = setCookie.split(';')[0];
        }

        const csrfStart = await getCsrfToken(agent);
        await agent.post('/api/lab/testlab/start').set('x-csrf-token', csrfStart).send({});

        port = await ctx.listen();
    });

    after(async () => {
        if (ctx) await ctx.close();
    });

    it('authenticates, receives a slot, uploads, and records a grade', async () => {
        const socket = connectSocket(port, cookie);
        await new Promise((resolve, reject) => {
            socket.on('connect', resolve);
            socket.on('connect_error', reject);
        });

        await new Promise((resolve, reject) => {
            socket.emit('authenticate');
            socket.once('auth_success', resolve);
            socket.once('auth_fail', () => reject(new Error('auth failed')));
        });

        socket.emit('request_grade_slot', {
            labId: 'testlab',
            fileSizeBytes: 64,
            _csrf: csrf,
        });

        const slotData = await waitForEvent(socket, 'grade_slot_ready');
        assert.ok(slotData.slotToken);

        socket.emit('upload_file', {
            labId: 'testlab',
            slotToken: slotData.slotToken,
            fileData: Buffer.alloc(64, 0xab),
            _csrf: csrf,
        });

        const result = await waitForEvent(socket, 'result');
        assert.equal(result.total, 5);
        assert.equal(result.max, 10);

        const row = ctx.db.prepare(
            "SELECT status, score, max_score FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1"
        ).get(studentId, 'testlab');
        assert.ok(row);
        assert.equal(row.score, 5);
        assert.equal(row.max_score, 10);

        socket.disconnect();
    });
});
