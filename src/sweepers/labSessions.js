const { elapsedSecondsSince } = require('../submissionDuration');
const { getConfigNumber } = require('../limits');
const { invalidateLeaderboardCache } = require('../leaderboardCache');
const { createLabSessionService } = require('../services/labSessionService');

function sweepLabSessionsOnce(db, getConfig, isWindowOpen) {
    const labSessionService = createLabSessionService(db);
    db.clearStaleLocks();

    const cfg = getConfig();
    const labs = cfg.labs || [];
    const inProgress = db.prepare("SELECT * FROM submissions WHERE status = 'in_progress' AND type = 'lab'").all();
    let cacheDirty = false;

    inProgress.forEach((sub) => {
        const labCfg = labs.find((l) => l.id === sub.lab_id);
        if (!labCfg) return;

        let closeSession = false;
        let reason = '';
        const timeLimitMinutes = getConfigNumber(labCfg.time_limit_minutes, 0);

        if (labSessionService.isTimeExpired(sub.timestamp, timeLimitMinutes)) {
            closeSession = true;
            reason = 'Auto-closed: Time limit expired.';
        }

        if (!isWindowOpen(labCfg)) {
            closeSession = true;
            reason = 'Auto-closed: Competition window ended.';
        }

        if (!closeSession) return;

        const lockKey = `lab_${sub.user_id}_${sub.lab_id}`;
        if (!db.acquireLock(lockKey)) {
            return;
        }

        try {
            const durationSeconds = elapsedSecondsSince(sub.timestamp);
            const result = db.prepare("UPDATE submissions SET status = 'completed', score = 0, max_score = 0, details = ?, duration_seconds = ? WHERE id = ? AND status = 'in_progress'")
                .run(JSON.stringify([{ message: reason, device: 'N/A', possible: 0, awarded: 0, passed: false }]), durationSeconds, sub.id);
            if (result.changes > 0) cacheDirty = true;
        } finally {
            db.releaseLock(lockKey);
        }
    });

    if (cacheDirty) invalidateLeaderboardCache();
}

function startLabSessionsSweeper(db, getConfig, isWindowOpen, intervalMs = 60 * 1000) {
    const handle = setInterval(() => {
        try {
            sweepLabSessionsOnce(db, getConfig, isWindowOpen);
        } catch (e) {
            console.error('Error in sweeping routines:', e.message);
        }
    }, intervalMs);

    if (typeof handle.unref === 'function') handle.unref();
    return handle;
}

module.exports = { startLabSessionsSweeper, sweepLabSessionsOnce };
