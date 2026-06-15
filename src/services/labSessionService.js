const { elapsedSecondsSince, parseDbTimestamp } = require('../submissionDuration');
const { getConfigNumber } = require('../limits');

const TIME_LIMIT_GRACE_SECONDS = 2;

function getElapsedSeconds(timestamp) {
    const startTime = parseDbTimestamp(timestamp);
    return Math.floor((Date.now() - startTime) / 1000);
}

function isTimeExpired(timestamp, timeLimitMinutes) {
    if (timeLimitMinutes <= 0) return false;
    return getElapsedSeconds(timestamp) > (timeLimitMinutes * 60) + TIME_LIMIT_GRACE_SECONDS;
}

function getTimeRemainingSeconds(timestamp, timeLimitMinutes) {
    if (timeLimitMinutes <= 0) return null;
    const remaining = (timeLimitMinutes * 60) + TIME_LIMIT_GRACE_SECONDS - getElapsedSeconds(timestamp);
    return Math.max(0, remaining);
}

function isAutoClosedLabDetails(detailsJson) {
    try {
        const arr = JSON.parse(detailsJson);
        if (!Array.isArray(arr) || arr.length !== 1) return false;
        const item = arr[0];
        if (!item || item.passed !== false) return false;
        const msg = item.message;
        if (typeof msg !== 'string') return false;
        return msg.startsWith('Auto-closed:')
            || msg === 'Time expired.'
            || msg === 'Time expired on submission.';
    } catch {
        return false;
    }
}

function createLabSessionService(db) {
    return {
        isSubmissionLockHeld(lockKey) {
            return Boolean(db.prepare('SELECT 1 FROM active_locks WHERE lock_key = ?').get(lockKey));
        },

        getActiveSession(userId, labId) {
            return db.prepare(
                "SELECT id, timestamp FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'lab' ORDER BY id DESC LIMIT 1"
            ).get(userId, labId);
        },

        getElapsedSeconds,
        isTimeExpired,
        getTimeRemainingSeconds,

        closeExpiredSession(submissionId, timestamp, message) {
            const elapsed = elapsedSecondsSince(timestamp);
            db.prepare("UPDATE submissions SET status = 'completed', score = 0, max_score = 0, details = ?, duration_seconds = ? WHERE id = ?")
                .run(JSON.stringify([{ message, device: 'N/A', possible: 0, awarded: 0, passed: false }]), elapsed, submissionId);
        },

        getTimeLimitMinutes(labCfg) {
            return getConfigNumber(labCfg.time_limit_minutes, 0);
        },
    };
}

module.exports = {
    createLabSessionService,
    TIME_LIMIT_GRACE_SECONDS,
    getElapsedSeconds,
    isTimeExpired,
    getTimeRemainingSeconds,
    isAutoClosedLabDetails,
};
