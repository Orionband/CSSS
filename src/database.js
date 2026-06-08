const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const LOCK_STALE_MINUTES = 10;
const SERVER_PID = process.pid;

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM';
    }
}

const db = new Database('grader.db');

try {
    fs.chmodSync(path.resolve(__dirname, '..', 'grader.db'), 0o600);
} catch (e) {
    console.warn('Warning: Could not set database file permissions:', e.message);
}

// Enable Write-Ahead Logging to prevent database locking on concurrent writes
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

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

// Create indexes to optimize query lookups and prevent full-table scans
db.prepare('CREATE INDEX IF NOT EXISTS idx_submissions_user_lab ON submissions (user_id, lab_id)').run();
db.prepare('CREATE INDEX IF NOT EXISTS idx_submissions_timestamp ON submissions (timestamp)').run();

try { db.prepare('SELECT lab_id FROM submissions LIMIT 1').get(); } 
catch (e) { db.prepare('ALTER TABLE submissions ADD COLUMN lab_id TEXT').run(); }

try { db.prepare('SELECT type FROM submissions LIMIT 1').get(); } 
catch (e) { db.prepare("ALTER TABLE submissions ADD COLUMN type TEXT DEFAULT 'lab'").run(); }

try { db.prepare('SELECT status FROM submissions LIMIT 1').get(); } 
catch (e) { db.prepare("ALTER TABLE submissions ADD COLUMN status TEXT DEFAULT 'completed'").run(); }

try { db.prepare('SELECT is_admin FROM users LIMIT 1').get(); } 
catch (e) { db.prepare("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0").run(); }

try { db.prepare('SELECT score_adjustment FROM users LIMIT 1').get(); } 
catch (e) { db.prepare("ALTER TABLE users ADD COLUMN score_adjustment INTEGER DEFAULT 0").run(); }

try { db.prepare('SELECT withheld FROM users LIMIT 1').get(); }
catch (e) { db.prepare("ALTER TABLE users ADD COLUMN withheld INTEGER DEFAULT 0").run(); }

try { db.prepare('SELECT password_changed_at FROM users LIMIT 1').get(); }
catch (e) { db.prepare("ALTER TABLE users ADD COLUMN password_changed_at INTEGER").run(); }

try { db.prepare('SELECT is_owner FROM users LIMIT 1').get(); }
catch (e) { db.prepare('ALTER TABLE users ADD COLUMN is_owner INTEGER DEFAULT 0').run(); }

try { db.prepare('SELECT duration_seconds FROM submissions LIMIT 1').get(); }
catch (e) { db.prepare('ALTER TABLE submissions ADD COLUMN duration_seconds INTEGER').run(); }

try { db.prepare('SELECT stream_poll FROM submissions LIMIT 1').get(); }
catch (e) { db.prepare('ALTER TABLE submissions ADD COLUMN stream_poll INTEGER DEFAULT 0').run(); }

/** Lab attempts for max_submissions — excludes live-stream poll rows. */
db.countLabAttempts = function(userId, labId) {
    return db.prepare(
        'SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND lab_id = ? AND COALESCE(stream_poll, 0) = 0'
    ).get(userId, labId).c;
};

try { db.prepare('SELECT owner_pid FROM active_locks LIMIT 1').get(); }
catch (e) { db.prepare('ALTER TABLE active_locks ADD COLUMN owner_pid INTEGER').run(); }

db.clearStaleLocks = function() {
    db.prepare(
        `DELETE FROM active_locks WHERE timestamp < datetime('now', '-${LOCK_STALE_MINUTES} minutes') AND (owner_pid IS NULL OR owner_pid != ?)`
    ).run(SERVER_PID);

    const rows = db.prepare('SELECT lock_key, owner_pid FROM active_locks WHERE owner_pid IS NOT NULL').all();
    for (const row of rows) {
        if (row.owner_pid !== SERVER_PID && !isProcessAlive(row.owner_pid)) {
            db.prepare('DELETE FROM active_locks WHERE lock_key = ?').run(row.lock_key);
        }
    }
};

db.acquireLock = function(key) {
    try {
        db.prepare('INSERT INTO active_locks (lock_key, owner_pid) VALUES (?, ?)').run(key, SERVER_PID);
        return true;
    } catch (e) {
        return false;
    }
};

db.releaseLock = function(key) {
    try {
        db.prepare('DELETE FROM active_locks WHERE lock_key = ? AND owner_pid = ?').run(key, SERVER_PID);
    } catch (e) {}
};

db.releaseAllServerLocks = function() {
    try {
        db.prepare('DELETE FROM active_locks WHERE owner_pid = ?').run(SERVER_PID);
    } catch (e) {}
};

/** Persist a completed lab grade; reconciles if the session was auto-closed while grading. */
db.recordLabGradeResult = function(userId, labId, submissionId, total, max, detailsJson) {
    const primary = db.prepare(
        "UPDATE submissions SET score = ?, max_score = ?, details = ?, status = 'completed' WHERE id = ? AND user_id = ? AND lab_id = ? AND status = 'in_progress'"
    ).run(total, max, detailsJson, submissionId, userId, labId);
    if (primary.changes > 0) return true;

    const reconcile = db.prepare(
        "UPDATE submissions SET score = ?, max_score = ?, details = ? WHERE id = ? AND user_id = ? AND lab_id = ? AND status = 'completed' AND score = 0 AND max_score = 0"
    ).run(total, max, detailsJson, submissionId, userId, labId);
    return reconcile.changes > 0;
};

/** Remove stored matching-quiz mappings for a user (e.g. after timeout without submit). */
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

// Drop stale grading locks on startup (TTL + dead owner processes).
try {
    db.clearStaleLocks();
} catch (e) {
    console.error('Failed to clear stale locks on startup:', e.message);
}

function releaseLocksOnShutdown() {
    try {
        db.releaseAllServerLocks();
    } catch (e) {
        console.error('Failed to release server locks on shutdown:', e.message);
    }
}

process.once('SIGTERM', releaseLocksOnShutdown);
process.once('SIGINT', releaseLocksOnShutdown);

module.exports = db;