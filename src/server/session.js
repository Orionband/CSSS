const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);

function createSessionMiddleware(db, sessionSecret, options = {}) {
    const storeOptions = { client: db, expired: { clear: true, intervalMs: 900000 } };
    if (options.disableStoreSweep) {
        storeOptions.expired = { clear: false };
    }
    return session({
        store: new SqliteStore(storeOptions),
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            secure: 'auto',
            sameSite: 'lax',
            maxAge: 24 * 60 * 60 * 1000,
        },
    });
}

function createSessionValidationMiddleware(db) {
    return (req, res, next) => {
        if (req.session && req.session.userId) {
            const user = db.prepare('SELECT id, password_changed_at FROM users WHERE id = ?').get(req.session.userId);
            if (!user) {
                req.session.destroy(() => {
                    res.clearCookie('connect.sid');
                    return res.status(401).json({ error: 'Session invalidated: Account no longer exists.' });
                });
                return;
            }
            if (user.password_changed_at && (!req.session.authenticatedAt || req.session.authenticatedAt < user.password_changed_at)) {
                req.session.destroy(() => {
                    res.clearCookie('connect.sid');
                    return res.status(401).json({ error: 'Session invalidated: Password was reset. Please log in again.' });
                });
                return;
            }
        }
        next();
    };
}

function createCsrfMiddleware() {
    return (req, res, next) => {
        if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

        const clientToken = req.headers['x-csrf-token'] || (req.body && req.body._csrf);

        if (!req.session || !req.session.csrfToken || clientToken !== req.session.csrfToken) {
            return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
        }

        next();
    };
}

function validateReloadedSession(db, sess) {
    if (!sess?.userId || !sess.uniqueId) return null;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(sess.userId);
    if (!user) return null;
    if (user.password_changed_at && (!sess.authenticatedAt || sess.authenticatedAt < user.password_changed_at)) {
        return null;
    }
    return user;
}

module.exports = {
    createSessionMiddleware,
    createSessionValidationMiddleware,
    createCsrfMiddleware,
    validateReloadedSession,
};
