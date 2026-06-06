const { MAX_FIELD_LEN } = require('./sanitizeUserFields');

/** bcrypt ignores password bytes beyond 72 (UTF-8). */
const BCRYPT_MAX_PASSWORD_BYTES = 72;

function passwordUtf8ByteLength(password) {
    return Buffer.byteLength(String(password), 'utf8');
}

function validatePasswordPolicy(password) {
    const pwd = String(password);
    if (pwd.length > MAX_FIELD_LEN) {
        return { ok: false, error: 'Password must be 100 characters or less.' };
    }
    if (passwordUtf8ByteLength(pwd) > BCRYPT_MAX_PASSWORD_BYTES) {
        return { ok: false, error: 'Password must be 72 bytes or less (UTF-8).' };
    }
    if (pwd.length < 8) {
        return { ok: false, error: 'Password must be at least 8 characters.' };
    }
    if (!/[A-Z]/.test(pwd)) {
        return { ok: false, error: 'Password must contain at least one uppercase letter.' };
    }
    if (!/[0-9]/.test(pwd)) {
        return { ok: false, error: 'Password must contain at least one number.' };
    }
    if (!/[^A-Za-z0-9]/.test(pwd)) {
        return { ok: false, error: 'Password must contain at least one symbol.' };
    }
    return { ok: true };
}

module.exports = {
    BCRYPT_MAX_PASSWORD_BYTES,
    passwordUtf8ByteLength,
    validatePasswordPolicy,
};
