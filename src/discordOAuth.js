const crypto = require('crypto');
const { URL, URLSearchParams } = require('url');
const { customAlphabet } = require('nanoid');
const { sanitizeUsername } = require('./sanitizeUserFields');
const { logAccountCreated } = require('./auditLog');

const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_USER_URL = 'https://discord.com/api/users/@me';
const ALLOWED_DISCORD_HOSTS = new Set([
    'discord.com',
    'www.discord.com',
    'discordapp.com',
    'www.discordapp.com',
]);
const ALLOWED_CALLBACK_SUFFIXES = [
    '/api/auth/discord/callback',
    '/auth/discord/callback',
];

function envBool(name, defaultValue = false) {
    const val = process.env[name];
    if (val === undefined || val === null || String(val).trim() === '') return defaultValue;
    return String(val).trim().toLowerCase() === 'true';
}

function getDiscordConfig() {
    const enabled = envBool('DISCORD_AUTH_ENABLED', false);
    const clientId = (process.env.DISCORD_CLIENT_ID || '').trim();
    const clientSecret = (process.env.DISCORD_CLIENT_SECRET || '').trim();
    const redirectUri = (process.env.DISCORD_REDIRECT_URI || '').trim();
    const scope = (process.env.DISCORD_OAUTH_SCOPE || 'identify').trim() || 'identify';
    const configured = Boolean(enabled && clientId && clientSecret && redirectUri);
    return { enabled, clientId, clientSecret, redirectUri, scope, configured };
}

function isAllowedCallbackPath(pathname) {
    return ALLOWED_CALLBACK_SUFFIXES.includes(pathname);
}

function parseDiscordOAuthUrl(raw) {
    let url;
    try {
        url = new URL(String(raw).trim());
    } catch {
        throw new Error('Invalid OAuth URL.');
    }

    if (!ALLOWED_DISCORD_HOSTS.has(url.hostname)) {
        throw new Error('URL must be a Discord OAuth authorize URL (discord.com).');
    }

    const clientId = url.searchParams.get('client_id');
    const redirectUri = url.searchParams.get('redirect_uri');
    const scopeRaw = url.searchParams.get('scope') || '';
    const scopes = scopeRaw.split(/\s+/).filter(Boolean);

    if (!clientId) throw new Error('Missing client_id in OAuth URL.');
    if (!redirectUri) throw new Error('Missing redirect_uri in OAuth URL.');
    if (!scopes.includes('identify')) {
        throw new Error('OAuth URL scope must include identify.');
    }

    let redirectPath;
    try {
        redirectPath = new URL(redirectUri).pathname;
    } catch {
        throw new Error('Invalid redirect_uri in OAuth URL.');
    }

    if (!isAllowedCallbackPath(redirectPath)) {
        throw new Error(
            'redirect_uri path must be /api/auth/discord/callback or /auth/discord/callback.'
        );
    }

    return {
        clientId,
        redirectUri,
        scope: scopes.join(' '),
    };
}

function buildAuthorizeUrl({ clientId, redirectUri, scope, state }) {
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scope || 'identify',
        state,
    });
    return `${DISCORD_AUTHORIZE_URL}?${params.toString()}`;
}

function generateUniqueId() {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const nanoid = customAlphabet(alphabet, 12);
    const id = nanoid();
    return id.match(/.{1,4}/g).join('-');
}

function discordDisplayName(profile) {
    if (profile.global_name && String(profile.global_name).trim()) {
        return String(profile.global_name).trim();
    }
    if (profile.username && String(profile.username).trim()) {
        return String(profile.username).trim();
    }
    return '';
}

function sanitizeDiscordHandle(handle) {
    let base = String(handle || '')
        .normalize('NFC')
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^[_.-]+|[_.-]+$/g, '');

    if (!base || base.length < 2) return '';
    if (base.length > 80) base = base.slice(0, 80);
    return base;
}

function baseUsernameFromDiscord(profile) {
    const fromHandle = sanitizeDiscordHandle(profile.username);
    if (fromHandle) return fromHandle;

    const idSuffix = String(profile.id || '').slice(-8) || crypto.randomBytes(4).toString('hex');
    return `discord_${idSuffix}`;
}

function allocateDiscordUsername(db, profile) {
    const root = baseUsernameFromDiscord(profile);
    let candidate = root;
    let attempt = 0;

    while (attempt < 1000) {
        const sanitized = sanitizeUsername(candidate);
        if (sanitized && !db.prepare('SELECT id FROM users WHERE username = ?').get(sanitized)) {
            return sanitized;
        }
        attempt += 1;
        candidate = `${root}_${attempt}`;
        if (candidate.length > 100) {
            candidate = `${root.slice(0, 90)}_${attempt}`;
        }
    }

    return sanitizeUsername(`discord_${String(profile.id)}`) || `discord_${String(profile.id).slice(-8)}`;
}

async function exchangeCodeForToken({ code, clientId, clientSecret, redirectUri }, fetchImpl = globalThis.fetch) {
    const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
    });

    const res = await fetchImpl(DISCORD_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
        const err = new Error('Discord token exchange failed.');
        err.status = res.status;
        throw err;
    }
    return data;
}

async function fetchDiscordUser(accessToken, fetchImpl = globalThis.fetch) {
    const res = await fetchImpl(DISCORD_USER_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.id) {
        const err = new Error('Failed to fetch Discord user profile.');
        err.status = res.status;
        throw err;
    }
    return data;
}

function findOrCreateDiscordUser(db, profile) {
    const discordId = String(profile.id);
    const discordHandle = String(profile.username || '').trim();
    const discordUsername = discordHandle || discordDisplayName(profile);

    const existing = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
    if (existing) {
        db.prepare('UPDATE users SET discord_username = ? WHERE id = ?').run(discordUsername, existing.id);
        return existing;
    }

    if (!envBool('ALLOW_REGISTRATION', false)) {
        const err = new Error('Registration is currently disabled by the administrator.');
        err.code = 'REGISTRATION_DISABLED';
        throw err;
    }

    const username = allocateDiscordUsername(db, profile);
    const uid = generateUniqueId();

    const info = db.prepare(
        'INSERT INTO users (username, email, password, unique_id, discord_id, discord_username) VALUES (?, NULL, NULL, ?, ?, ?)'
    ).run(username, uid, discordId, discordUsername);

    logAccountCreated({
        actorUserId: null,
        targetUserId: info.lastInsertRowid,
        username,
        isAdmin: false,
        isOwner: false,
        source: 'discord_oauth',
    });

    return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

module.exports = {
    ALLOWED_CALLBACK_SUFFIXES,
    buildAuthorizeUrl,
    exchangeCodeForToken,
    fetchDiscordUser,
    findOrCreateDiscordUser,
    getDiscordConfig,
    parseDiscordOAuthUrl,
    envBool,
};
