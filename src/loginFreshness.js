function loginCredentialsStillValid(dbConn, userId, snapshot) {
    const fresh = dbConn.prepare('SELECT password, password_changed_at FROM users WHERE id = ?').get(userId);
    if (!fresh) return false;
    if (fresh.password !== snapshot.passwordHashAtRead) return false;
    const changedAt = fresh.password_changed_at ?? null;
    const changedAtAtRead = snapshot.passwordChangedAtAtRead ?? null;
    if (changedAt !== changedAtAtRead) return false;
    if (changedAt != null && changedAt > snapshot.loginStartedAt) return false;
    return true;
}

module.exports = { loginCredentialsStillValid };
