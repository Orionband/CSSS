const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../../src/database');
const { sweepLabSessionsOnce } = require('../../src/sweepers/labSessions');
const { getCachedLeaderboard, invalidateLeaderboardCache } = require('../../src/leaderboardCache');
const { buildLeaderboard } = require('../../src/leaderboardScores');

describe('sweepLabSessionsOnce', () => {
    let db;

    beforeEach(() => {
        db = createDatabase(':memory:', { silentChmod: true, skipStaleLockClear: true });
        db.prepare(
            'INSERT INTO users (username, email, password, unique_id) VALUES (?, ?, ?, ?)'
        ).run('student', 'student@test.local', 'hash', 'UID-0001');
        invalidateLeaderboardCache();
    });

    afterEach(() => {
        if (db?.closeDatabase) db.closeDatabase();
    });

    it('invalidates leaderboard cache when auto-closing an expired lab session', () => {
        const cfg = {
            labs: [{ id: 'lab1', title: 'Lab', time_limit_minutes: 1, show_score: true }],
            quizzes: [],
        };
        const past = new Date(Date.now() - 3 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

        db.prepare(`
            INSERT INTO submissions (user_id, unique_id, lab_id, score, max_score, type, status, timestamp)
            VALUES (1, 'UID-0001', 'lab1', 0, 0, 'lab', 'in_progress', ?)
        `).run(past);

        let builds = 0;
        const build = () => {
            builds++;
            return buildLeaderboard(cfg);
        };

        getCachedLeaderboard(build);
        getCachedLeaderboard(build);
        assert.equal(builds, 1);

        sweepLabSessionsOnce(db, () => cfg, () => true);

        const row = db.prepare("SELECT status FROM submissions WHERE lab_id = 'lab1'").get();
        assert.equal(row.status, 'completed');

        getCachedLeaderboard(build);
        assert.equal(builds, 2);
    });
});
