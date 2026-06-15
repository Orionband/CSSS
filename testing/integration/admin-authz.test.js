const { describe, it, after, before } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const request = require('supertest');const { createTestApp, loginAgent, getCsrfToken } = require('../helpers/testApp');

describe('admin/owner permission boundaries', () => {
    let ctx;

    after(async () => {
        if (ctx) await ctx.close();
    });

    before(() => {
        ctx = createTestApp();
    });

    it('rejects non-admin on /api/admin/users', async () => {
        const agent = request.agent(ctx.app);
        await loginAgent(agent, 'student', 'student-pass-1');
        const res = await agent.get('/api/admin/users');
        assert.equal(res.status, 403);
    });

    it('allows admin to list users', async () => {
        const agent = request.agent(ctx.app);
        await loginAgent(agent, 'admin', 'admin-pass-1');
        const res = await agent.get('/api/admin/users');
        assert.equal(res.status, 200);
        assert.equal(res.body.success, true);
    });

    it('blocks admin from creating another admin without owner', async () => {
        const agent = request.agent(ctx.app);
        await loginAgent(agent, 'admin', 'admin-pass-1');
        const csrf = await getCsrfToken(agent);
        const res = await agent
            .post('/api/admin/users')
            .set('x-csrf-token', csrf)
            .send({
                username: 'newadmin',
                email: 'newadmin@test.local',
                password: 'Admin1!pass',
                is_admin: true,
            });
        assert.equal(res.status, 403);
    });

    it('allows owner to create admin accounts', async () => {
        const agent = request.agent(ctx.app);
        await loginAgent(agent, 'owner', 'owner-pass-1');
        const csrf = await getCsrfToken(agent);
        const res = await agent
            .post('/api/admin/users')
            .set('x-csrf-token', csrf)
            .send({
                username: 'newadmin2',
                email: 'newadmin2@test.local',
                password: 'Admin1!pass',
                is_admin: true,
            });
        assert.equal(res.status, 200);
        assert.equal(res.body.success, true);
    });

    it('requires current password to delete a user', async () => {
        ctx.db.prepare('INSERT INTO users (username, email, password, unique_id) VALUES (?, ?, ?, ?)')
            .run('delme', 'delme@test.local', bcrypt.hashSync('pass-123456', 4), 'DEL-1111-1111');
        const target = ctx.db.prepare('SELECT id FROM users WHERE username = ?').get('delme');

        const agent = request.agent(ctx.app);
        await loginAgent(agent, 'owner', 'owner-pass-1');
        const csrf = await getCsrfToken(agent);

        const missing = await agent
            .delete(`/api/admin/users/${target.id}`)
            .set('x-csrf-token', csrf)
            .send({});
        assert.equal(missing.status, 400);
        assert.match(missing.body.error, /current password/i);

        const wrong = await agent
            .delete(`/api/admin/users/${target.id}`)
            .set('x-csrf-token', csrf)
            .send({ current_password: 'wrong-pass-1' });
        assert.equal(wrong.status, 403);

        const ok = await agent
            .delete(`/api/admin/users/${target.id}`)
            .set('x-csrf-token', csrf)
            .send({ current_password: 'owner-pass-1' });
        assert.equal(ok.status, 200);
        assert.equal(ok.body.success, true);
    });
});
