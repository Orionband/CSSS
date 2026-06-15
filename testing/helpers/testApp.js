const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { purgeProjectCache } = require('./purgeCache');
const { seedUsers, fixtureConfig } = require('./fixtures');

const DEFAULT_MOCK_POOL = {
    poolSize: 1,
    getPendingCount: () => 0,
    enqueue: (_payload, _transfer, _onMsg, onErr) => {
        if (onErr) onErr('Grading is not available in this test harness.');
    },
    shutdown: () => {},
};

const SUCCESS_MOCK_POOL = {
    poolSize: 1,
    getPendingCount: () => 0,
    enqueue: (_payload, _transfer, onMsg) => {
        setImmediate(() => {
            onMsg({ type: 'file_verified' });
            onMsg({
                type: 'result',
                grading: {
                    total: 5,
                    max: 10,
                    show_score: true,
                    serverBreakdown: [],
                    clientBreakdown: [],
                },
            });
        });
    },
    shutdown: () => {},
};

function prepareTestEnv() {
    const dbPath = path.join(os.tmpdir(), `csss-test-${crypto.randomBytes(6).toString('hex')}.db`);
    process.env.GRADER_DB_PATH = dbPath;
    process.env.NODE_ENV = 'test';
    process.env.CSSS_SKIP_ASSET_VALIDATION = 'true';
    process.env.SESSION_SECRET = process.env.SESSION_SECRET || `test-${'x'.repeat(26)}`;
    process.env.MAX_WORKERS = '1';
    purgeProjectCache();
    return dbPath;
}

function removeDbFiles(dbPath) {
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
    }
}

function createTestApp(configOverride = null, options = {}) {
    const dbPath = prepareTestEnv();
    const { createDatabase } = require('../../src/database');
    const db = createDatabase(dbPath, { silentChmod: true, skipStaleLockClear: false });
    const users = seedUsers(db);
    const getConfig = () => configOverride || fixtureConfig;
    const { setConfigOverride, clearConfigOverride } = require('../../src/config');
    setConfigOverride(configOverride || fixtureConfig);

    const { createApp } = require('../../src/server/createApp');
    const graderPool = options.graderPool || DEFAULT_MOCK_POOL;
    const runtime = createApp({
        db,
        getConfig,
        sessionSecret: process.env.SESSION_SECRET,
        testMode: true,
        graderPool,
    });

    let closed = false;

    return {
        db,
        dbPath,
        users,
        runtime,
        app: runtime.app,
        server: runtime.server,
        getConfig,
        async listen() {
            await new Promise((resolve, reject) => {
                runtime.server.once('error', reject);
                runtime.server.listen(0, () => {
                    runtime.server.removeListener('error', reject);
                    resolve();
                });
            });
            const { port } = runtime.server.address();
            return port;
        },
        async close() {
            if (closed) return;
            closed = true;

            if (global.activeUserSockets?.size) {
                for (const socketSet of global.activeUserSockets.values()) {
                    for (const socket of socketSet) {
                        try { socket.disconnect(true); } catch { /* ignore */ }
                    }
                }
                global.activeUserSockets.clear();
            }
            delete global.activeUserSockets;

            await runtime.stop();

            const defaultDb = require('../../src/database');
            if (defaultDb !== db && typeof defaultDb.closeDatabase === 'function') {
                defaultDb.closeDatabase();
            }

            removeDbFiles(dbPath);
            clearConfigOverride();
        },
    };
}

async function loginAgent(agent, username, password) {
    const csrf = await getCsrfToken(agent);
    const res = await agent
        .post('/api/login')
        .set('x-csrf-token', csrf)
        .send({ username, password });
    return res;
}

async function getCsrfToken(agent) {
    const res = await agent.get('/api/csrf-token');
    return res.body.csrfToken;
}

module.exports = { createTestApp, loginAgent, getCsrfToken, prepareTestEnv, DEFAULT_MOCK_POOL, SUCCESS_MOCK_POOL };
