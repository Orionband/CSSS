const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { isAutoClosedLabDetails } = require('./services/labSessionService');

const LOCK_STALE_MINUTES = 10;

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM';
    }
}

function attachDbMethods(db, serverPid) {
    db.countLabAttempts = function(userId, labId) {
        return db.prepare(
            'SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND lab_id = ? AND COALESCE(stream_poll, 0) = 0'
        ).get(userId, labId).c;
    };

    db.clearStaleLocks = function() {
        db.prepare(
            `DELETE FROM active_locks WHERE timestamp < datetime('now', '-${LOCK_STALE_MINUTES} minutes') AND (owner_pid IS NULL OR owner_pid != ?)`
        ).run(serverPid);

        const rows = db.prepare('SELECT lock_key, owner_pid FROM active_locks WHERE owner_pid IS NOT NULL').all();
        for (const row of rows) {
            if (row.owner_pid !== serverPid && !isProcessAlive(row.owner_pid)) {
                db.prepare('DELETE FROM active_locks WHERE lock_key = ?').run(row.lock_key);
            }
        }
    };

    db.acquireLock = function(key) {
        try {
            db.prepare('INSERT INTO active_locks (lock_key, owner_pid) VALUES (?, ?)').run(key, serverPid);
            return true;
        } catch (e) {
            return false;
        }
    };

    db.releaseLock = function(key) {
        try {
            db.prepare('DELETE FROM active_locks WHERE lock_key = ? AND owner_pid = ?').run(key, serverPid);
        } catch (e) { /* ignore */ }
    };

    db.releaseAllServerLocks = function() {
        try {
            db.prepare('DELETE FROM active_locks WHERE owner_pid = ?').run(serverPid);
        } catch (e) { /* ignore */ }
    };

    db.recordLabGradeResult = function(userId, labId, submissionId, total, max, detailsJson) {
        const primary = db.prepare(
            "UPDATE submissions SET score = ?, max_score = ?, details = ?, status = 'completed' WHERE id = ? AND user_id = ? AND lab_id = ? AND status = 'in_progress'"
        ).run(total, max, detailsJson, submissionId, userId, labId);
        if (primary.changes > 0) return true;

        const existing = db.prepare(
            "SELECT details FROM submissions WHERE id = ? AND user_id = ? AND lab_id = ? AND status = 'completed' AND score = 0 AND max_score = 0"
        ).get(submissionId, userId, labId);
        if (!existing || !isAutoClosedLabDetails(existing.details)) return false;

        const reconcile = db.prepare(
            "UPDATE submissions SET score = ?, max_score = ?, details = ? WHERE id = ? AND user_id = ? AND lab_id = ? AND status = 'completed' AND score = 0 AND max_score = 0"
        ).run(total, max, detailsJson, submissionId, userId, labId);
        return reconcile.changes > 0;
    };

    db.clearQuizMappingsForUser = function(userId, quizId) {
        try {
            const rows = db.prepare(
                "SELECT sid, sess FROM sessions WHERE json_extract(sess, '$.userId') = ?"
            ).all(userId);
            const update = db.prepare('UPDATE sessions SET sess = ? WHERE sid = ?');
            for (const row of rows) {
                let sess;
                try {
                    sess = JSON.parse(row.sess);
                } catch {
                    continue;
                }
                if (!sess.quizMappings || !sess.quizMappings[quizId]) continue;
                delete sess.quizMappings[quizId];
                if (Object.keys(sess.quizMappings).length === 0) delete sess.quizMappings;
                update.run(JSON.stringify(sess), row.sid);
            }
        } catch (e) {
            console.error('clearQuizMappingsForUser:', e.message);
        }
    };

    db.closeDatabase = function() {
        try {
            db.close();
        } catch (e) { /* ignore */ }
    };

    return db;
}

function runMigrations(db) {
    db.prepare(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            email TEXT UNIQUE,
            password TEXT,
            unique_id TEXT UNIQUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            is_admin INTEGER DEFAULT 0,
            score_adjustment INTEGER DEFAULT 0,
            withheld INTEGER DEFAULT 0
        )
    `).run();

    db.prepare(`
        CREATE TABLE IF NOT EXISTS submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            unique_id TEXT,
            lab_id TEXT,
            score INTEGER,
            max_score INTEGER,
            details TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            type TEXT DEFAULT 'lab',
            status TEXT DEFAULT 'completed',
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
    `).run();

    db.prepare(`
        CREATE TABLE IF NOT EXISTS active_locks (
            lock_key TEXT PRIMARY KEY,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `).run();

    db.prepare('CREATE INDEX IF NOT EXISTS idx_submissions_user_lab ON submissions (user_id, lab_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_submissions_timestamp ON submissions (timestamp)').run();

    const migrations = [
        ['lab_id', 'ALTER TABLE submissions ADD COLUMN lab_id TEXT'],
        ['type', "ALTER TABLE submissions ADD COLUMN type TEXT DEFAULT 'lab'"],
        ['status', "ALTER TABLE submissions ADD COLUMN status TEXT DEFAULT 'completed'"],
        ['is_admin', 'ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0'],
        ['score_adjustment', 'ALTER TABLE users ADD COLUMN score_adjustment INTEGER DEFAULT 0'],
        ['withheld', 'ALTER TABLE users ADD COLUMN withheld INTEGER DEFAULT 0'],
        ['password_changed_at', 'ALTER TABLE users ADD COLUMN password_changed_at INTEGER'],
        ['is_owner', 'ALTER TABLE users ADD COLUMN is_owner INTEGER DEFAULT 0'],
        ['duration_seconds', 'ALTER TABLE submissions ADD COLUMN duration_seconds INTEGER'],
        ['stream_poll', 'ALTER TABLE submissions ADD COLUMN stream_poll INTEGER DEFAULT 0'],
        ['owner_pid', 'ALTER TABLE active_locks ADD COLUMN owner_pid INTEGER'],
    ];

    for (const [col, sql] of migrations) {
        const table = sql.includes('users') ? 'users' : sql.includes('active_locks') ? 'active_locks' : 'submissions';
        try {
            db.prepare(`SELECT ${col} FROM ${table} LIMIT 1`).get();
        } catch (e) {
            db.prepare(sql).run();
        }
    }
}

function createDatabase(dbPath = process.env.GRADER_DB_PATH || 'grader.db', options = {}) {
    const serverPid = options.serverPid ?? process.pid;
    const db = new Database(dbPath);

    if (dbPath !== ':memory:') {
        try {
            const resolved = path.isAbsolute(dbPath) ? dbPath : path.resolve(dbPath);
            fs.chmodSync(resolved, 0o600);
        } catch (e) {
            if (!options.silentChmod) {
                console.warn('Warning: Could not set database file permissions:', e.message);
            }
        }
    }

    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');

    runMigrations(db);
    attachDbMethods(db, serverPid);

    if (!options.skipStaleLockClear) {
        try {
            db.clearStaleLocks();
        } catch (e) {
            console.error('Failed to clear stale locks on startup:', e.message);
        }
    }

    return db;
}

const defaultDb = createDatabase();

module.exports = defaultDb;
module.exports.createDatabase = createDatabase;
