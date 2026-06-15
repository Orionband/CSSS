const { describe, it, after, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { io: ioClient } = require('socket.io-client');
const { createTestApp, loginAgent, getCsrfToken } = require('../helpers/testApp');

function connectSocket(port, cookieHeader) {
    return ioClient(`http://127.0.0.1:${port}`, {
        transports: ['websocket'],
        extraHeaders: cookieHeader ? { cookie: cookieHeader } : {},
    });
}

describe('socket upload slot lifecycle', () => {
    let ctx;
    let port;
    let cookie;
    let csrf;

    before(async () => {
        ctx = createTestApp();
        const agent = request.agent(ctx.app);
        const loginRes = await loginAgent(agent, 'student', 'student-pass-1');
        assert.equal(loginRes.status, 200);
        csrf = loginRes.body.csrfToken || (await getCsrfToken(agent));
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

    it('authenticates and cancels a waiting grade slot', async () => {
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

        const waitingPromise = new Promise((resolve) => {
            socket.once('grade_slot_waiting', resolve);
        });

        socket.emit('request_grade_slot', {
            labId: 'testlab',
            fileSizeBytes: 1024,
            _csrf: csrf,
        });

        await waitingPromise;

        socket.emit('cancel_grade_slot', { labId: 'testlab', _csrf: csrf });

        socket.disconnect();
    });
});
