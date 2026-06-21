const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { URL } = require('url');
const { createTestApp, getCsrfToken } = require('../helpers/testApp');
const { fixtureConfig, homepageFixture } = require('../helpers/fixtures');
const { purgeProjectCache } = require('../helpers/purgeCache');

function enableDiscordEnv() {
    process.env.DISCORD_AUTH_ENABLED = 'true';
    process.env.DISCORD_CLIENT_ID = 'test-client-id';
    process.env.DISCORD_CLIENT_SECRET = 'test-client-secret';
    process.env.DISCORD_REDIRECT_URI = 'http://127.0.0.1:10000/api/auth/discord/callback';
    process.env.DISCORD_OAUTH_SCOPE = 'identify';
    process.env.ALLOW_REGISTRATION = 'true';
}

function mockDiscordFetch() {
    global.fetch = async (url) => {
        const target = String(url);
        if (target.includes('/oauth2/token')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ access_token: 'mock-access-token', token_type: 'Bearer' }),
            };
        }
        if (target.includes('/users/@me')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    id: '555000111222333444',
                    username: 'discord_student',
                    global_name: 'Discord Student',
                }),
            };
        }
        throw new Error(`Unexpected fetch URL in test: ${target}`);
    };
}

describe('discord auth integration', () => {
    let ctx;
    let originalFetch;

    after(async () => {
        global.fetch = originalFetch;
        delete process.env.DISCORD_AUTH_ENABLED;
        delete process.env.DISCORD_CLIENT_ID;
        delete process.env.DISCORD_CLIENT_SECRET;
        delete process.env.DISCORD_REDIRECT_URI;
        delete process.env.DISCORD_OAUTH_SCOPE;
        delete process.env.ALLOW_REGISTRATION;
        if (ctx) await ctx.close();
    });

    before(() => {
        originalFetch = global.fetch;
        enableDiscordEnv();
        purgeProjectCache();
        mockDiscordFetch();
        ctx = createTestApp();
    });

    it('exposes discord_auth_enabled in public config when configured', async () => {
        const res = await request(ctx.app).get('/api/config');
        assert.equal(res.status, 200);
        assert.equal(res.body.options.discord_auth_enabled, true);
    });

    it('redirects to Discord authorize URL with state', async () => {
        const agent = request.agent(ctx.app);
        const res = await agent.get('/api/auth/discord').redirects(0);
        assert.equal(res.status, 302);
        assert.match(res.headers.location, /^https:\/\/discord\.com\/oauth2\/authorize\?/);
        assert.match(res.headers.location, /state=/);
    });

    it('completes OAuth callback, creates user, and establishes session', async () => {
        const agent = request.agent(ctx.app);
        const start = await agent.get('/api/auth/discord').redirects(0);
        const location = new URL(start.headers.location);
        const state = location.searchParams.get('state');
        assert.ok(state);

        const callback = await agent
            .get(`/api/auth/discord/callback?code=mock-code&state=${encodeURIComponent(state)}`)
            .redirects(0);
        assert.equal(callback.status, 302);
        assert.equal(callback.headers.location, '/challenges');

        const me = await agent.get('/api/me');
        assert.equal(me.status, 200);
        assert.ok(me.body.username);
        assert.ok(me.body.unique_id);

        const row = ctx.db.prepare('SELECT * FROM users WHERE discord_id = ?').get('555000111222333444');
        assert.ok(row);
        assert.equal(row.username, me.body.username);
    });

    it('rejects callback with invalid state', async () => {
        const agent = request.agent(ctx.app);
        await agent.get('/api/auth/discord').redirects(0);
        const bad = await agent
            .get('/api/auth/discord/callback?code=mock-code&state=not-the-right-state')
            .redirects(0);
        assert.equal(bad.status, 302);
        assert.match(bad.headers.location, /^\/\?discord_error=/);
    });

    it('redirects Discord callback failure to /login when homepage is enabled', async () => {
        const homepageCtx = createTestApp({
            ...fixtureConfig,
            homepage: homepageFixture,
        });
        try {
            const agent = request.agent(homepageCtx.app);
            await agent.get('/api/auth/discord').redirects(0);
            const bad = await agent
                .get('/api/auth/discord/callback?code=mock-code&state=not-the-right-state')
                .redirects(0);
            assert.equal(bad.status, 302);
            assert.match(bad.headers.location, /^\/login\?discord_error=/);
        } finally {
            await homepageCtx.close();
        }
    });

    it('rejects password login when Discord auth is enabled', async () => {
        const oauthUser = ctx.db.prepare('SELECT * FROM users WHERE discord_id = ?').get('555000111222333444');
        assert.ok(oauthUser);

        const agent = request.agent(ctx.app);
        const csrf = await getCsrfToken(agent);
        const login = await agent
            .post('/api/login')
            .set('x-csrf-token', csrf)
            .send({ username: oauthUser.username, password: 'anything' });
        assert.equal(login.status, 403);
        assert.match(login.body.error, /Discord/i);
    });

    it('rejects new discord sign-in when registration is disabled', async () => {
        const agent = request.agent(ctx.app);
        const start = await agent.get('/api/auth/discord').redirects(0);
        const location = new URL(start.headers.location);
        const state = location.searchParams.get('state');

        global.fetch = async (url) => {
            const target = String(url);
            if (target.includes('/oauth2/token')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ access_token: 'mock-access-token', token_type: 'Bearer' }),
                };
            }
            if (target.includes('/users/@me')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        id: '999888777666555444',
                        username: 'blocked_new_user',
                        global_name: 'Blocked New User',
                    }),
                };
            }
            throw new Error(`Unexpected fetch URL in test: ${target}`);
        };

        delete process.env.ALLOW_REGISTRATION;
        const callback = await agent
            .get(`/api/auth/discord/callback?code=mock-code&state=${encodeURIComponent(state)}`)
            .redirects(0);
        process.env.ALLOW_REGISTRATION = 'true';
        mockDiscordFetch();

        assert.equal(callback.status, 302);
        assert.match(callback.headers.location, /discord_error=/);
        assert.match(decodeURIComponent(callback.headers.location), /disabled/i);

        const row = ctx.db.prepare('SELECT * FROM users WHERE discord_id = ?').get('999888777666555444');
        assert.equal(row, undefined);
    });

    it('rejects password registration when Discord auth is enabled', async () => {
        const agent = request.agent(ctx.app);
        const csrf = await getCsrfToken(agent);
        const res = await agent
            .post('/api/register')
            .set('x-csrf-token', csrf)
            .send({
                username: 'newstudent',
                email: 'new@test.local',
                password: 'ValidPass1!',
            });
        assert.equal(res.status, 403);
        assert.match(res.body.error, /Discord/i);
    });

    it('completes discord reauth for an already signed-in discord admin', async () => {
        const adminCtx = createTestApp();
        const adminRow = adminCtx.db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
        const session = { userId: adminRow.id, adminDiscordReauthAt: Date.now() };
        const { getAdminReauthStatus } = require('../../src/adminReauth');
        const status = getAdminReauthStatus(session, { discord_id: '555000111222333444' });
        assert.equal(status.method, 'discord');
        assert.equal(status.discordValid, true);
        await adminCtx.close();
    });
});

describe('discord auth disabled', () => {
    let ctx;

    after(async () => {
        delete process.env.DISCORD_AUTH_ENABLED;
        delete process.env.DISCORD_CLIENT_ID;
        delete process.env.DISCORD_CLIENT_SECRET;
        delete process.env.DISCORD_REDIRECT_URI;
        delete process.env.DISCORD_OAUTH_SCOPE;
        if (ctx) await ctx.close();
    });

    before(() => {
        process.env.DISCORD_AUTH_ENABLED = 'false';
        purgeProjectCache();
        ctx = createTestApp();
    });

    it('returns 404 for discord start route when disabled', async () => {
        const res = await request(ctx.app).get('/api/auth/discord');
        assert.equal(res.status, 404);
    });

    it('does not expose discord auth in config when disabled', async () => {
        const res = await request(ctx.app).get('/api/config');
        assert.equal(res.body.options.discord_auth_enabled, false);
    });

    it('rejects discord reauth start for non-admin linked users', async () => {
        const appCtx = createTestApp();
        const res = await request(appCtx.app).get('/api/auth/discord/reauth?return=/admin');
        assert.equal(res.status, 401);
        await appCtx.close();
    });
});
