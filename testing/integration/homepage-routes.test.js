const { describe, it, after, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createTestApp } = require('../helpers/testApp');
const { fixtureConfig, homepageFixture } = require('../helpers/fixtures');

describe('homepage routes', () => {
    let defaultCtx;
    let homepageCtx;

    before(() => {
        defaultCtx = createTestApp();
        homepageCtx = createTestApp({
            ...fixtureConfig,
            homepage: homepageFixture,
        });
    });

    after(async () => {
        if (defaultCtx) await defaultCtx.close();
        if (homepageCtx) await homepageCtx.close();
    });

    it('serves login at / when homepage is disabled', async () => {
        const res = await request(defaultCtx.app).get('/');
        assert.equal(res.status, 200);
        assert.match(res.text, /id="login-form"/);
    });

    it('serves homepage at / when homepage is enabled', async () => {
        const res = await request(homepageCtx.app).get('/');
        assert.equal(res.status, 200);
        assert.match(res.text, /id="home-title"/);
        assert.doesNotMatch(res.text, /id="login-form"/);
    });

    it('serves login at /login when homepage is enabled', async () => {
        const res = await request(homepageCtx.app).get('/login');
        assert.equal(res.status, 200);
        assert.match(res.text, /id="login-form"/);
    });

    it('redirects /login to / when homepage is disabled', async () => {
        const res = await request(defaultCtx.app).get('/login');
        assert.equal(res.status, 302);
        assert.equal(res.headers.location, '/');
    });

    it('exposes homepage in /api/config when enabled', async () => {
        const res = await request(homepageCtx.app).get('/api/config');
        assert.equal(res.status, 200);
        assert.equal(res.body.homepage.page_title, 'Test Event');
        assert.equal(res.body.options.homepage_enabled, true);
    });

    it('omits homepage from /api/config when disabled', async () => {
        const res = await request(defaultCtx.app).get('/api/config');
        assert.equal(res.status, 200);
        assert.equal(res.body.homepage, undefined);
        assert.equal(res.body.options.homepage_enabled, false);
    });

    it('redirects unauthenticated /admin to /login when homepage is enabled', async () => {
        const res = await request(homepageCtx.app).get('/admin');
        assert.equal(res.status, 302);
        assert.equal(res.headers.location, '/login');
    });

    it('sets nav-brand href to / on shell pages when homepage is enabled', async () => {
        const res = await request(homepageCtx.app).get('/challenges');
        assert.equal(res.status, 200);
        assert.match(res.text, /<a href="\/" class="nav-brand navElement" id="nav-brand"><\/a>/);
    });

    it('sets nav-brand href to /challenges when homepage is disabled', async () => {
        const res = await request(defaultCtx.app).get('/challenges');
        assert.equal(res.status, 200);
        assert.match(res.text, /<a href="\/challenges" class="nav-brand navElement" id="nav-brand"><\/a>/);
    });

    it('returns null competition status for invalid homepage dates', async () => {
        const invalidCtx = createTestApp({
            ...fixtureConfig,
            homepage: {
                ...homepageFixture,
                comp_start: 'not-a-date',
                comp_end: 'also-bad',
            },
        });
        try {
            const res = await request(invalidCtx.app).get('/api/config');
            assert.equal(res.status, 200);
            assert.equal(res.body.homepage.period.status, null);
        } finally {
            await invalidCtx.close();
        }
    });
});
