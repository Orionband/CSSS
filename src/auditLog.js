const fs = require('fs');
const path = require('path');

const AUDIT_LOG_DIR = path.join(__dirname, '..', 'logs');
const AUDIT_LOG_PATH = path.join(AUDIT_LOG_DIR, 'audit.log');
const MAX_DETAIL_LEN = 500;
const MAX_ERROR_DETAIL_LEN = 8000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const REVERSE_CHUNK_SIZE = 64 * 1024;

const EVENT_TYPES = Object.freeze({
    ACCOUNT_CREATED: 'account_created',
    PASSWORD_CHANGED: 'password_changed',
    ADMIN_GRANTED: 'admin_granted',
    ADMIN_REVOKED: 'admin_revoked',
    OWNER_GRANTED: 'owner_granted',
    USER_DELETED: 'user_deleted',
    SERVER_ERROR: 'server_error',
});

const EVENT_TYPE_SET = new Set(Object.values(EVENT_TYPES));

const SENSITIVE_PATTERNS = [
    /password\s*[:=]\s*\S+/gi,
    /secret\s*[:=]\s*\S+/gi,
    /token\s*[:=]\s*\S+/gi,
    /bearer\s+\S+/gi,
    /authorization\s*[:=]\s*\S+/gi,
    /\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{53}/g,
];

let entrySeq = 0;

function isValidEventType(value) {
    return EVENT_TYPE_SET.has(value);
}

function auditLogFilePaths() {
    return [AUDIT_LOG_PATH, `${AUDIT_LOG_PATH}.1`];
}

function sanitizeDetail(raw, { maxLen = MAX_DETAIL_LEN } = {}) {
    if (raw == null || raw === '') return null;
    let text = String(raw)
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .trim();
    for (const pattern of SENSITIVE_PATTERNS) {
        pattern.lastIndex = 0;
        text = text.replace(pattern, '[redacted]');
    }
    if (text.length > maxLen) {
        text = text.slice(0, maxLen - 3) + '...';
    }
    return text || null;
}

function ensureAuditFile() {
    if (!fs.existsSync(AUDIT_LOG_DIR)) {
        fs.mkdirSync(AUDIT_LOG_DIR, { recursive: true });
    }
    if (!fs.existsSync(AUDIT_LOG_PATH)) {
        fs.writeFileSync(AUDIT_LOG_PATH, '', { mode: 0o600 });
        return;
    }
    try {
        fs.chmodSync(AUDIT_LOG_PATH, 0o600);
    } catch (e) {
        console.warn('Warning: Could not set audit log file permissions:', e.message);
    }
}

function rotateIfNeeded() {
    try {
        const stat = fs.statSync(AUDIT_LOG_PATH);
        if (stat.size <= MAX_FILE_BYTES) return;
        const rotated = `${AUDIT_LOG_PATH}.1`;
        if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
        fs.renameSync(AUDIT_LOG_PATH, rotated);
        fs.writeFileSync(AUDIT_LOG_PATH, '', { mode: 0o600 });
    } catch (e) {
        console.error('Audit log rotation failed:', e.message);
    }
}

function appendEntry(entry) {
    ensureAuditFile();
    rotateIfNeeded();
    const line = JSON.stringify(entry) + '\n';
    try {
        fs.appendFileSync(AUDIT_LOG_PATH, line, { mode: 0o600 });
    } catch (e) {
        console.error('FATAL: Failed to write audit log entry:', e.message);
    }
}

function recordAudit(eventType, fields = {}) {
    if (!isValidEventType(eventType)) {
        console.error(`Audit log rejected unknown event type: ${eventType}`);
        return;
    }

    const {
        actorUserId = null,
        targetUserId = null,
        labId = null,
        detail = null,
        source = null,
        isError = false,
    } = fields;

    const safeLabId = labId != null && String(labId).length <= 100 ? String(labId) : null;
    const safeSource = source != null && String(source).length <= 50 ? String(source) : null;
    const maxLen = isError ? MAX_ERROR_DETAIL_LEN : MAX_DETAIL_LEN;

    const entry = {
        id: `${Date.now()}-${++entrySeq}`,
        created_at: new Date().toISOString(),
        event_type: eventType,
        actor_user_id: Number.isFinite(actorUserId) ? actorUserId : null,
        target_user_id: Number.isFinite(targetUserId) ? targetUserId : null,
        lab_id: safeLabId,
        detail: sanitizeDetail(detail, { maxLen }),
        source: safeSource,
    };

    try {
        appendEntry(entry);
    } catch (e) {
        console.error('FATAL: Failed to write audit log entry:', e.message);
    }
}

function logAccountCreated({ actorUserId, targetUserId, username, isAdmin, isOwner, source }) {
    let detail;
    if (isOwner) {
        detail = username ? `Owner account created: ${username}` : 'Owner account created';
    } else if (isAdmin) {
        detail = username ? `Admin account created: ${username}` : 'Admin account created';
    } else {
        detail = username ? `Account created: ${username}` : 'Account created';
    }
    recordAudit(EVENT_TYPES.ACCOUNT_CREATED, {
        actorUserId,
        targetUserId,
        detail,
        source,
    });
}

function passwordChangeDetail({ actorUserId, targetUserId, targetUsername, source }) {
    switch (source) {
        case 'admin_panel':
            if (actorUserId === targetUserId) {
                return 'Admin reset own password via admin panel';
            }
            return targetUsername
                ? `Admin reset password for ${targetUsername}`
                : `Admin reset password for user id ${targetUserId}`;
        case 'cli':
            return targetUsername
                ? `Password reset via CLI for ${targetUsername}`
                : 'Password reset via CLI';
        case 'quickstart':
            return targetUsername
                ? `Password reset via quickstart for ${targetUsername}`
                : 'Password reset via quickstart owner setup';
        default:
            return targetUsername ? `Password changed for ${targetUsername}` : 'Password changed';
    }
}

function logPasswordChanged({ actorUserId, targetUserId, targetUsername, source }) {
    recordAudit(EVENT_TYPES.PASSWORD_CHANGED, {
        actorUserId,
        targetUserId,
        detail: passwordChangeDetail({ actorUserId, targetUserId, targetUsername, source }),
        source,
    });
}

function logAdminChange({ granted, actorUserId, targetUserId, username, source }) {
    recordAudit(granted ? EVENT_TYPES.ADMIN_GRANTED : EVENT_TYPES.ADMIN_REVOKED, {
        actorUserId,
        targetUserId,
        detail: username
            ? (granted ? `Admin granted to ${username}` : `Admin revoked from ${username}`)
            : (granted ? 'Admin privileges granted' : 'Admin privileges revoked'),
        source,
    });
}

function logOwnerGranted({ actorUserId, targetUserId, username, source }) {
    recordAudit(EVENT_TYPES.OWNER_GRANTED, {
        actorUserId,
        targetUserId,
        detail: username ? `Owner privileges granted to ${username}` : 'Owner privileges granted',
        source,
    });
}

function logUserDeleted({ actorUserId, targetUserId, username, source }) {
    recordAudit(EVENT_TYPES.USER_DELETED, {
        actorUserId,
        targetUserId,
        detail: username ? `User deleted: ${username}` : `User deleted (id ${targetUserId})`,
        source,
    });
}

function logServerError({ userId, labId, detail, source = 'grading' }) {
    recordAudit(EVENT_TYPES.SERVER_ERROR, {
        targetUserId: Number.isFinite(userId) ? userId : null,
        labId,
        detail,
        source,
        isError: true,
    });
}

function parseAuditLine(line) {
    try {
        const parsed = JSON.parse(line);
        if (parsed && isValidEventType(parsed.event_type)) {
            return parsed;
        }
    } catch (e) {
    }
    return null;
}

function* linesReverse(filePath) {
    if (!fs.existsSync(filePath)) return;

    const fd = fs.openSync(filePath, 'r');
    try {
        const size = fs.fstatSync(fd).size;
        if (size === 0) return;

        let position = size;
        let trailing = '';
        const buffer = Buffer.alloc(REVERSE_CHUNK_SIZE);

        while (position > 0) {
            const readSize = Math.min(REVERSE_CHUNK_SIZE, position);
            position -= readSize;
            fs.readSync(fd, buffer, 0, readSize, position);
            const chunk = buffer.slice(0, readSize).toString('utf8') + trailing;
            const parts = chunk.split('\n');
            trailing = parts.shift() || '';
            for (let i = parts.length - 1; i >= 0; i--) {
                const trimmed = parts[i].trim();
                if (trimmed) yield trimmed;
            }
        }

        const last = trailing.trim();
        if (last) yield last;
    } finally {
        fs.closeSync(fd);
    }
}

function collectEntriesNewestFirst({ eventType, maxCollect }) {
    const entries = [];
    for (const filePath of auditLogFilePaths()) {
        for (const line of linesReverse(filePath)) {
            const entry = parseAuditLine(line);
            if (!entry) continue;
            if (eventType && entry.event_type !== eventType) continue;
            entries.push(entry);
            if (entries.length >= maxCollect) {
                return { entries, stoppedEarly: true };
            }
        }
    }
    return { entries, stoppedEarly: false };
}

function resolveUsernames(entries) {
    const db = require('./database');
    const ids = new Set();
    for (const e of entries) {
        if (Number.isFinite(e.actor_user_id)) ids.add(e.actor_user_id);
        if (Number.isFinite(e.target_user_id)) ids.add(e.target_user_id);
    }
    const nameMap = {};
    if (ids.size > 0) {
        const placeholders = [...ids].map(() => '?').join(',');
        db.prepare(`SELECT id, username FROM users WHERE id IN (${placeholders})`)
            .all(...ids)
            .forEach(row => { nameMap[row.id] = row.username; });
    }
    return entries.map(e => ({
        ...e,
        actor_username: e.actor_user_id != null ? (nameMap[e.actor_user_id] || null) : null,
        target_username: e.target_user_id != null ? (nameMap[e.target_user_id] || null) : null,
    }));
}

function readAuditLog({ limit = 50, offset = 0, eventType = null } = {}) {
    const filterType = eventType && isValidEventType(eventType) ? eventType : null;
    const maxCollect = offset + limit + 1;
    const { entries: collected, stoppedEarly } = collectEntriesNewestFirst({
        eventType: filterType,
        maxCollect,
    });

    const slice = collected.slice(offset, offset + limit);
    const hasMore = stoppedEarly || collected.length > offset + limit;
    const total = hasMore ? null : offset + slice.length;

    return {
        entries: resolveUsernames(slice),
        total,
        limit,
        offset,
        hasMore,
    };
}

module.exports = {
    EVENT_TYPES,
    EVENT_TYPE_SET,
    isValidEventType,
    recordAudit,
    logAccountCreated,
    logPasswordChanged,
    logAdminChange,
    logOwnerGranted,
    logUserDeleted,
    logServerError,
    sanitizeDetail,
    readAuditLog,
};
