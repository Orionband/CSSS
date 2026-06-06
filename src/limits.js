const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_LEADERBOARD = 500;
const DEFAULT_UPLOAD_MB = 75;

/** Skip X-Forwarded-For vs trust-proxy check when TRUST_PROXY is unset (direct/ngrok without .env). */
const trustProxyEnabled = Boolean(process.env.TRUST_PROXY?.trim());

function parsePagination(query, { defaultLimit = DEFAULT_LIMIT, maxLimit = MAX_LIMIT } = {}) {
    let limit = parseInt(query?.limit, 10);
    let offset = parseInt(query?.offset, 10);
    if (!Number.isFinite(limit) || limit < 1) limit = defaultLimit;
    if (!Number.isFinite(offset) || offset < 0) offset = 0;
    limit = Math.min(limit, maxLimit);
    return { limit, offset };
}

function rateLimitPreset(overrides = {}) {
    return {
        standardHeaders: true,
        legacyHeaders: false,
        validate: {
            xForwardedForHeader: trustProxyEnabled,
        },
        ...overrides,
    };
}

function resolveUploadMb(raw, defaultMb = DEFAULT_UPLOAD_MB) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return defaultMb;
    return n;
}

function maxUploadMbFromLabs(labs) {
    let max = DEFAULT_UPLOAD_MB;
    for (const lab of labs || []) {
        const mb = resolveUploadMb(lab.max_upload_mb);
        if (mb > max) max = mb;
    }
    return max;
}

function getConfigNumber(value, defaultValue) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultValue;
}

function ensureArray(value) {
    return Array.isArray(value) ? value : [];
}

module.exports = {
    DEFAULT_LIMIT,
    MAX_LIMIT,
    MAX_LEADERBOARD,
    DEFAULT_UPLOAD_MB,
    trustProxyEnabled,
    parsePagination,
    rateLimitPreset,
    resolveUploadMb,
    maxUploadMbFromLabs,
    getConfigNumber,
    ensureArray,
};
