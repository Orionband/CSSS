const bcrypt = require('bcryptjs');
const { getDiscordConfig } = require('./discordOAuth');

const ADMIN_DISCORD_REAUTH_TTL_MS = 5 * 60 * 1000;

function isDiscordReauthValid(session) {
    const at = session?.adminDiscordReauthAt;
    if (!at || typeof at !== 'number') return false;
    return Date.now() - at < ADMIN_DISCORD_REAUTH_TTL_MS;
}

function getAdminReauthMethod(user, discordConfigured) {
    if (discordConfigured && user?.discord_id) return 'discord';
    return 'password';
}

function getAdminReauthStatus(session, user) {
    const discordConfigured = getDiscordConfig().configured;
    const method = getAdminReauthMethod(user, discordConfigured);
    return {
        method,
        discordValid: method === 'discord' && isDiscordReauthValid(session),
    };
}

async function verifyAdminSensitiveAction(req, current_password, dbConn = require('./database')) {
    if (!req.session?.userId) {
        return { ok: false, status: 401, error: 'Unauthorized' };
    }

    const adminUser = dbConn
        .prepare('SELECT password, discord_id FROM users WHERE id = ?')
        .get(req.session.userId);

    if (!adminUser) {
        return { ok: false, status: 401, error: 'Unauthorized' };
    }

    const discordConfigured = getDiscordConfig().configured;
    const method = getAdminReauthMethod(adminUser, discordConfigured);

    if (method === 'discord') {
        if (isDiscordReauthValid(req.session)) {
            return { ok: true };
        }
        return {
            ok: false,
            status: 403,
            error: 'Confirm this action with Discord first.',
            code: 'DISCORD_REAUTH_REQUIRED',
        };
    }

    if (!adminUser.password) {
        return {
            ok: false,
            status: 403,
            error: 'This account has no password. Enable Discord authentication or set a password before confirming sensitive actions.',
            code: 'PASSWORD_NOT_SET',
        };
    }

    if (!current_password) {
        return {
            ok: false,
            status: 400,
            error: 'Current password confirmation is required.',
        };
    }

    const valid = await bcrypt.compare(String(current_password), adminUser.password);
    if (!valid) {
        return { ok: false, status: 403, error: 'Current password is incorrect.' };
    }

    return { ok: true };
}

function sanitizeAdminReturnTo(value) {
    if (typeof value !== 'string' || !value.startsWith('/admin')) return '/admin';
    if (value.includes('//') || value.includes('\\')) return '/admin';
    const pathOnly = value.split('?')[0];
    if (pathOnly !== '/admin') return '/admin';
    return value;
}

module.exports = {
    ADMIN_DISCORD_REAUTH_TTL_MS,
    getAdminReauthMethod,
    getAdminReauthStatus,
    isDiscordReauthValid,
    sanitizeAdminReturnTo,
    verifyAdminSensitiveAction,
};
