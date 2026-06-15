function createUserService(db) {
    return {
        getById(userId) {
            return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        },

        getSessionFields(userId) {
            return db.prepare('SELECT id, password_changed_at, is_admin, is_owner FROM users WHERE id = ?').get(userId);
        },

        isSessionValid(user, authenticatedAt) {
            if (!user) return false;
            if (user.password_changed_at && (!authenticatedAt || authenticatedAt < user.password_changed_at)) {
                return false;
            }
            return true;
        },
    };
}

module.exports = { createUserService };
