const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { createDatabase } = require('../../src/database');
const { loginCredentialsStillValid } = require('../../src/loginFreshness');

describe('loginCredentialsStillValid', () => {
    it('returns true when credentials unchanged', () => {
        const db = createDatabase(':memory:', { silentChmod: true, skipStaleLockClear: true });
        const hash = bcrypt.hashSync('pass-123456', 4);
        const info = db.prepare(
            'INSERT INTO users (username, email, password, unique_id) VALUES (?, ?, ?, ?)'
        ).run('u1', 'u1@test.local', hash, 'UID-0001');
        const loginStartedAt = Date.now();
        const snapshot = {
            passwordHashAtRead: hash,
            passwordChangedAtAtRead: null,
            loginStartedAt,
        };
        assert.equal(loginCredentialsStillValid(db, info.lastInsertRowid, snapshot), true);
    });

    it('returns false when password hash changed during compare', () => {
        const db = createDatabase(':memory:', { silentChmod: true, skipStaleLockClear: true });
        const oldHash = bcrypt.hashSync('old-pass-12', 4);
        const info = db.prepare(
            'INSERT INTO users (username, email, password, unique_id) VALUES (?, ?, ?, ?)'
        ).run('u2', 'u2@test.local', oldHash, 'UID-0002');
        const loginStartedAt = Date.now();
        const snapshot = {
            passwordHashAtRead: oldHash,
            passwordChangedAtAtRead: null,
            loginStartedAt,
        };
        const newHash = bcrypt.hashSync('new-pass-12', 4);
        db.prepare('UPDATE users SET password = ?, password_changed_at = ? WHERE id = ?')
            .run(newHash, Date.now(), info.lastInsertRowid);
        assert.equal(loginCredentialsStillValid(db, info.lastInsertRowid, snapshot), false);
    });

    it('returns false when password_changed_at advanced during compare', () => {
        const db = createDatabase(':memory:', { silentChmod: true, skipStaleLockClear: true });
        const hash = bcrypt.hashSync('pass-123456', 4);
        const info = db.prepare(
            'INSERT INTO users (username, email, password, unique_id) VALUES (?, ?, ?, ?)'
        ).run('u3', 'u3@test.local', hash, 'UID-0003');
        const loginStartedAt = Date.now() - 50;
        const snapshot = {
            passwordHashAtRead: hash,
            passwordChangedAtAtRead: null,
            loginStartedAt,
        };
        db.prepare('UPDATE users SET password_changed_at = ? WHERE id = ?')
            .run(Date.now(), info.lastInsertRowid);
        assert.equal(loginCredentialsStillValid(db, info.lastInsertRowid, snapshot), false);
    });

    it('returns false when password_changed_at is set after loginStartedAt', () => {
        const db = createDatabase(':memory:', { silentChmod: true, skipStaleLockClear: true });
        const hash = bcrypt.hashSync('pass-123456', 4);
        const loginStartedAt = Date.now() - 100;
        const info = db.prepare(
            'INSERT INTO users (username, email, password, unique_id, password_changed_at) VALUES (?, ?, ?, ?, ?)'
        ).run('u4', 'u4@test.local', hash, 'UID-0004', loginStartedAt);
        const snapshot = {
            passwordHashAtRead: hash,
            passwordChangedAtAtRead: loginStartedAt,
            loginStartedAt,
        };
        db.prepare('UPDATE users SET password_changed_at = ? WHERE id = ?')
            .run(Date.now(), info.lastInsertRowid);
        assert.equal(loginCredentialsStillValid(db, info.lastInsertRowid, snapshot), false);
    });
});
