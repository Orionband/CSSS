const { describe, it, after, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createTestApp } = require('../helpers/testApp');

describe('page shell access control', () => {
    let ctx;

    after(async () => {
        if (ctx) await ctx.close();
    });

    before(() => {
        ctx = createTestApp();
    });

    it('redirects /admin.html to /admin', async () => {
        const res = await request(ctx.app).get('/admin.html');
        assert.equal(res.status, 301);
        assert.equal(res.headers.location, '/admin');
    });

    it('redirects encoded /admin%2ehtml to /admin', async () => {
        const res = await request(ctx.app).get('/admin%2ehtml');
        assert.equal(res.status, 301);
        assert.equal(res.headers.location, '/admin');
    });

    it('does not serve admin panel HTML without authentication', async () => {
        const res = await request(ctx.app).get('/admin');
        assert.equal(res.status, 302);
        assert.equal(res.headers.location, '/');
    });

    it('blocks direct static access to page shell HTML files', async () => {
        const res = await request(ctx.app).get('/admin.html');
        assert.equal(res.status, 301);
        const follow = await request(ctx.app).get('/admin');
        assert.equal(follow.status, 302);

        const blocked = await request(ctx.app).get('/challenges.html');
        assert.equal(blocked.status, 301);
        const staticShell = await request(ctx.app).get('/challenges.html').redirects(0);
        assert.notEqual(staticShell.status, 200);
    });

    it('still serves static assets', async () => {
        const res = await request(ctx.app).get('/css/app.css');
        assert.equal(res.status, 200);
        assert.match(res.headers['content-type'] || '', /css/i);
    });
});
