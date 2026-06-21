const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { createDatabase } = require('../../src/database');const {
    getAdminReauthMethod,
    getAdminReauthStatus,
    isDiscordReauthValid,
    verifyAdminSensitiveAction,
} = require('../../src/adminReauth');

describe('adminReauth', () => {
    it('prefers discord confirmation when admin has discord linked', () => {
        process.env.DISCORD_AUTH_ENABLED = 'true';
        const method = getAdminReauthMethod({ password: 'hash', discord_id: '1' }, true);
        assert.equal(method, 'discord');
        delete process.env.DISCORD_AUTH_ENABLED;
    });

    it('uses password confirmation when admin has no discord link', () => {
        process.env.DISCORD_AUTH_ENABLED = 'true';
        const method = getAdminReauthMethod({ password: 'hash', discord_id: null }, true);
        assert.equal(method, 'password');
        delete process.env.DISCORD_AUTH_ENABLED;
    });

    it('requires password confirmation when discord is disabled even if a discord id exists', () => {
        const method = getAdminReauthMethod({ password: 'hash', discord_id: '1' }, false);
        assert.equal(method, 'password');
    });

    it('uses discord confirmation for discord-only admins', () => {
        process.env.DISCORD_AUTH_ENABLED = 'true';
        const method = getAdminReauthMethod({ password: null, discord_id: '1' }, true);
        assert.equal(method, 'discord');
        delete process.env.DISCORD_AUTH_ENABLED;
    });

    it('accepts recent discord reauth timestamps', () => {
        const session = { adminDiscordReauthAt: Date.now() };
        assert.equal(isDiscordReauthValid(session), true);
    });

    it('requires discord reauth for discord-only admins', async () => {
        process.env.DISCORD_AUTH_ENABLED = 'true';
        process.env.DISCORD_CLIENT_ID = 'id';
        process.env.DISCORD_CLIENT_SECRET = 'secret';
        process.env.DISCORD_REDIRECT_URI = 'http://localhost/api/auth/discord/callback';

        const db = createDatabase(':memory:', { silentChmod: true, skipStaleLockClear: true });
        const info = db.prepare(
            'INSERT INTO users (username, unique_id, discord_id, is_admin) VALUES (?, ?, ?, 1)'
        ).run('discord_admin', 'AAAA-BBBB-CCCC', '999');

        const req = { session: { userId: info.lastInsertRowid } };
        const denied = await verifyAdminSensitiveAction(req, '', db);
        assert.equal(denied.ok, false);
        assert.equal(denied.code, 'DISCORD_REAUTH_REQUIRED');

        req.session.adminDiscordReauthAt = Date.now();
        const allowed = await verifyAdminSensitiveAction(req, '', db);
        assert.equal(allowed.ok, true);

        delete process.env.DISCORD_AUTH_ENABLED;
        delete process.env.DISCORD_CLIENT_ID;
        delete process.env.DISCORD_CLIENT_SECRET;
        delete process.env.DISCORD_REDIRECT_URI;
    });

    it('requires discord reauth for hybrid admins with a password hash', async () => {
        process.env.DISCORD_AUTH_ENABLED = 'true';
        process.env.DISCORD_CLIENT_ID = 'id';
        process.env.DISCORD_CLIENT_SECRET = 'secret';
        process.env.DISCORD_REDIRECT_URI = 'http://localhost/api/auth/discord/callback';

        const db = createDatabase(':memory:', { silentChmod: true, skipStaleLockClear: true });
        const passwordHash = bcrypt.hashSync('known-password', 4);
        const info = db.prepare(
            'INSERT INTO users (username, unique_id, discord_id, password, is_admin) VALUES (?, ?, ?, ?, 1)'
        ).run('hybrid_admin', 'AAAA-BBBB-DDDD', '888', passwordHash);
        const req = { session: { userId: info.lastInsertRowid } };
        const denied = await verifyAdminSensitiveAction(req, 'known-password', db);
        assert.equal(denied.ok, false);
        assert.equal(denied.code, 'DISCORD_REAUTH_REQUIRED');

        delete process.env.DISCORD_AUTH_ENABLED;
        delete process.env.DISCORD_CLIENT_ID;
        delete process.env.DISCORD_CLIENT_SECRET;
        delete process.env.DISCORD_REDIRECT_URI;
    });

    it('reports password not set when discord is disabled for discord-only admins', async () => {
        delete process.env.DISCORD_AUTH_ENABLED;
        delete process.env.DISCORD_CLIENT_ID;
        delete process.env.DISCORD_CLIENT_SECRET;
        delete process.env.DISCORD_REDIRECT_URI;

        const db = createDatabase(':memory:', { silentChmod: true, skipStaleLockClear: true });
        const info = db.prepare(
            'INSERT INTO users (username, unique_id, discord_id, is_admin) VALUES (?, ?, ?, 1)'
        ).run('discord_only_admin', 'AAAA-BBBB-FFFF', '777');

        const req = { session: { userId: info.lastInsertRowid } };
        const denied = await verifyAdminSensitiveAction(req, '', db);
        assert.equal(denied.ok, false);
        assert.equal(denied.status, 403);
        assert.equal(denied.code, 'PASSWORD_NOT_SET');
        assert.match(denied.error, /no password/i);
    });

    it('treats missing password confirmation as a current password error when password auth applies', async () => {
        const db = createDatabase(':memory:', { silentChmod: true, skipStaleLockClear: true });
        const hash = bcrypt.hashSync('known-password', 4);
        const info = db.prepare(
            'INSERT INTO users (username, unique_id, password, is_admin) VALUES (?, ?, ?, 1)'
        ).run('password_admin', 'AAAA-BBBB-EEEE', hash);

        const req = { session: { userId: info.lastInsertRowid } };
        const denied = await verifyAdminSensitiveAction(req, '', db);
        assert.equal(denied.ok, false);
        assert.equal(denied.status, 400);
        assert.match(denied.error, /Current password/i);
    });

    it('reports discord reauth status on bootstrap payloads', () => {
        process.env.DISCORD_AUTH_ENABLED = 'true';
        process.env.DISCORD_CLIENT_ID = 'id';
        process.env.DISCORD_CLIENT_SECRET = 'secret';
        process.env.DISCORD_REDIRECT_URI = 'http://localhost/api/auth/discord/callback';
        const status = getAdminReauthStatus(
            { adminDiscordReauthAt: Date.now() },
            { password: null, discord_id: '123' },
        );
        assert.equal(status.method, 'discord');
        assert.equal(status.discordValid, true);
        delete process.env.DISCORD_AUTH_ENABLED;
        delete process.env.DISCORD_CLIENT_ID;
        delete process.env.DISCORD_CLIENT_SECRET;
        delete process.env.DISCORD_REDIRECT_URI;
    });
});
