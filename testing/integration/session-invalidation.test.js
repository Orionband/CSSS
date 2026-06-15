const { describe, it, after, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { createTestApp, loginAgent, getCsrfToken } = require('../helpers/testApp');

describe('session invalidation', () => {
    let ctx;

    after(async () => {
        if (ctx) await ctx.close();
    });

    before(() => {
        ctx = createTestApp();
    });

    it('invalidates session after password reset', async () => {
        const agent = request.agent(ctx.app);
        await loginAgent(agent, 'student', 'student-pass-1');
        const me1 = await agent.get('/api/me');
        assert.equal(me1.status, 200);

        const admin = request.agent(ctx.app);
        await loginAgent(admin, 'owner', 'owner-pass-1');
        const newHash = bcrypt.hashSync('new-student-pass', 4);
        ctx.db.prepare('UPDATE users SET password = ?, password_changed_at = ? WHERE username = ?')
            .run(newHash, Date.now(), 'student');

        const me2 = await agent.get('/api/me');
        assert.equal(me2.status, 401);
    });

    it('rejects login when password changes during bcrypt compare window', async () => {
        const student = ctx.db.prepare('SELECT * FROM users WHERE username = ?').get('student');
        const loginStartedAt = Date.now();
        const snapshot = {
            passwordHashAtRead: student.password,
            passwordChangedAtAtRead: student.password_changed_at ?? null,
            loginStartedAt,
        };

        const newHash = bcrypt.hashSync('new-student-pass', 4);
        ctx.db.prepare('UPDATE users SET password = ?, password_changed_at = ? WHERE id = ?')
            .run(newHash, Date.now(), student.id);

        const { loginCredentialsStillValid } = require('../../src/loginFreshness');
        assert.equal(loginCredentialsStillValid(ctx.db, student.id, snapshot), false);
    });

    it('invalidates session after user delete', async () => {
        ctx.db.prepare('INSERT INTO users (username, email, password, unique_id) VALUES (?, ?, ?, ?)')
            .run('todelete', 'del@test.local', bcrypt.hashSync('pass-123456', 4), 'DEL-0000-0000');
        const victim = ctx.db.prepare('SELECT id FROM users WHERE username = ?').get('todelete');

        const agent = request.agent(ctx.app);
        await loginAgent(agent, 'todelete', 'pass-123456');
        const ok = await agent.get('/api/me');
        assert.equal(ok.status, 200);

        const admin = request.agent(ctx.app);
        await loginAgent(admin, 'owner', 'owner-pass-1');
        const csrf = await getCsrfToken(admin);
        await admin
            .delete(`/api/admin/users/${victim.id}`)
            .set('x-csrf-token', csrf)
            .send({ current_password: 'owner-pass-1' });

        const blocked = await agent.get('/api/me');
        assert.equal(blocked.status, 401);
    });
});
