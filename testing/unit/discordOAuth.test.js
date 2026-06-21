const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { createDatabase } = require('../../src/database');
const {
    parseDiscordOAuthUrl,
    findOrCreateDiscordUser,
} = require('../../src/discordOAuth');

describe('discordOAuth helpers', () => {
    it('parses a valid Discord OAuth URL', () => {
        const parsed = parseDiscordOAuthUrl(
            'https://discord.com/oauth2/authorize?client_id=123456&response_type=code&scope=identify&redirect_uri=http%3A%2F%2Flocalhost%3A10000%2Fapi%2Fauth%2Fdiscord%2Fcallback'
        );
        assert.equal(parsed.clientId, '123456');
        assert.equal(parsed.redirectUri, 'http://localhost:10000/api/auth/discord/callback');
        assert.equal(parsed.scope, 'identify');
    });

    it('rejects OAuth URL without identify scope', () => {
        assert.throws(
            () => parseDiscordOAuthUrl(
                'https://discord.com/oauth2/authorize?client_id=1&redirect_uri=http%3A%2F%2Flocalhost%2Fapi%2Fauth%2Fdiscord%2Fcallback&scope=email'
            ),
            /identify/
        );
    });

    it('rejects OAuth URL with invalid callback path', () => {
        assert.throws(
            () => parseDiscordOAuthUrl(
                'https://discord.com/oauth2/authorize?client_id=1&redirect_uri=http%3A%2F%2Flocalhost%2Fwrong&scope=identify'
            ),
            /redirect_uri/
        );
    });

    it('rejects OAuth URL with prefix-injected callback path', () => {
        assert.throws(
            () => parseDiscordOAuthUrl(
                'https://discord.com/oauth2/authorize?client_id=1&redirect_uri=http%3A%2F%2Flocalhost%2Fhacker%2Fapi%2Fauth%2Fdiscord%2Fcallback&scope=identify'
            ),
            /redirect_uri/
        );
    });

    it('creates and reuses users by discord_id', () => {
        process.env.ALLOW_REGISTRATION = 'true';
        const db = createDatabase(':memory:', { silentChmod: true, skipStaleLockClear: true });
        const profile = { id: '9876543210', username: 'student_one', global_name: 'Student One' };

        const first = findOrCreateDiscordUser(db, profile);
        assert.ok(first.id);
        assert.equal(first.discord_id, '9876543210');
        assert.equal(first.username, 'student_one');

        const second = findOrCreateDiscordUser(db, { ...profile, global_name: 'Renamed' });
        assert.equal(second.id, first.id);
        assert.equal(second.username, 'student_one');
        delete process.env.ALLOW_REGISTRATION;
    });

    it('rejects new discord users when registration is disabled', () => {
        delete process.env.ALLOW_REGISTRATION;
        const db = createDatabase(':memory:', { silentChmod: true, skipStaleLockClear: true });
        const profile = { id: '4242424242', username: 'closed_user', global_name: 'Closed User' };

        assert.throws(
            () => findOrCreateDiscordUser(db, profile),
            (err) => err.code === 'REGISTRATION_DISABLED',
        );
    });

    it('allows existing discord users when registration is disabled', () => {
        process.env.ALLOW_REGISTRATION = 'true';
        const db = createDatabase(':memory:', { silentChmod: true, skipStaleLockClear: true });
        const profile = { id: '3131313131', username: 'returning_user', global_name: 'Returning User' };
        const created = findOrCreateDiscordUser(db, profile);
        delete process.env.ALLOW_REGISTRATION;

        const again = findOrCreateDiscordUser(db, profile);
        assert.equal(again.id, created.id);
    });

    it('uses unique discord handle even when display names match', () => {
        process.env.ALLOW_REGISTRATION = 'true';
        const db = createDatabase(':memory:', { silentChmod: true, skipStaleLockClear: true });
        const first = findOrCreateDiscordUser(db, {
            id: '1001',
            username: 'alex_net_01',
            global_name: 'Alex',
        });
        const second = findOrCreateDiscordUser(db, {
            id: '1002',
            username: 'alex_net_02',
            global_name: 'Alex',
        });

        assert.equal(first.username, 'alex_net_01');
        assert.equal(second.username, 'alex_net_02');
        delete process.env.ALLOW_REGISTRATION;
    });

    it('suffixes username when discord handle is already taken locally', () => {
        process.env.ALLOW_REGISTRATION = 'true';
        const db = createDatabase(':memory:', { silentChmod: true, skipStaleLockClear: true });
        db.prepare('INSERT INTO users (username, email, password, unique_id) VALUES (?, ?, ?, ?)')
            .run('student_one', 'taken@test.local', bcrypt.hashSync('x', 4), 'AAAA-BBBB-CCCC');

        const created = findOrCreateDiscordUser(db, {
            id: '111',
            username: 'student_one',
            global_name: 'Different Display Name',
        });
        assert.notEqual(created.username, 'student_one');
        assert.match(created.username, /^student_one_/);
        delete process.env.ALLOW_REGISTRATION;
    });
});
