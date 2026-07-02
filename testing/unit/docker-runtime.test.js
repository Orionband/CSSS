'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { purgeProjectCache } = require('../helpers/purgeCache');

describe('database module lazy singleton', () => {
    it('does not open a file when only createDatabase is imported', () => {
        purgeProjectCache();
        const phantomPath = path.join(os.tmpdir(), `csss-lazy-${Date.now()}.db`);
        process.env.GRADER_DB_PATH = phantomPath;
        const { createDatabase } = require('../../src/database');
        assert.equal(fs.existsSync(phantomPath), false);
        assert.equal(typeof createDatabase, 'function');
    });

    it('reflects opened database methods without eager open before first use', () => {
        purgeProjectCache();
        const dbModule = require('../../src/database');
        assert.deepEqual(Object.keys(dbModule), ['createDatabase', 'closeDefaultDatabaseIfOpen']);
        assert.equal('prepare' in dbModule, false);

        dbModule.prepare('SELECT 1').get();

        assert.equal('prepare' in dbModule, true);
        assert.ok(Object.keys(dbModule).includes('prepare'));
    });

    it('rejects overwriting module-level exports on the proxy', () => {
        purgeProjectCache();
        const dbModule = require('../../src/database');
        const original = dbModule.createDatabase;
        assert.equal(Reflect.set(dbModule, 'createDatabase', () => null), false);
        assert.equal(dbModule.createDatabase, original);
    });
});

describe('tool.js database path', () => {
    let dbPath;
    let db;
    let createDatabase;

    beforeEach(() => {
        ({ createDatabase } = require('../../src/database'));
        dbPath = path.join(os.tmpdir(), `csss-tool-${Date.now()}.db`);
        db = createDatabase(dbPath, { silentChmod: true });
    });

    afterEach(() => {
        if (db?.closeDatabase) db.closeDatabase();
        for (const suffix of ['', '-wal', '-shm']) {
            try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
        }
    });

    it('opens an explicit path via createDatabase (not the default singleton path)', () => {
        const row = db.prepare('SELECT 1 AS ok').get();
        assert.equal(row.ok, 1);
        assert.equal(fs.existsSync(dbPath), true);
    });
});

describe('createApp shutdown', () => {
    it('closes the database handle on stop()', async () => {
        const { createDatabase } = require('../../src/database');
        const dbPath = path.join(os.tmpdir(), `csss-stop-${Date.now()}.db`);
        const db = createDatabase(dbPath, { silentChmod: true });
        const { createApp } = require('../../src/server/createApp');
        const runtime = createApp({
            db,
            testMode: true,
            sessionSecret: `test-${'x'.repeat(26)}`,
            graderPool: {
                poolSize: 1,
                getPendingCount: () => 0,
                shutdown: () => {},
            },
        });

        await runtime.stop();

        assert.throws(() => db.prepare('SELECT 1').get(), /not open/i);

        for (const suffix of ['', '-wal', '-shm']) {
            try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
        }
    });
});
