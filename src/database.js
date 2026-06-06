const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
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

db.acquireLock = function(key) {
    try {
        db.prepare("INSERT INTO active_locks (lock_key) VALUES (?)").run(key);
        return true;
    } catch (e) {
        return false;
    }
};

db.releaseLock = function(key) {
    try {
        db.prepare("DELETE FROM active_locks WHERE lock_key = ?").run(key);
    } catch (e) {}
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

// Clear stale grading locks on application startup
try {
    db.prepare("DELETE FROM active_locks").run();
} catch (e) {
    console.error("Failed to clear startup locks:", e.message);
}

module.exports = db;