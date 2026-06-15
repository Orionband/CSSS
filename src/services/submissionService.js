function createSubmissionService(db) {
    return {
        countLabAttempts(userId, labId) {
            return db.countLabAttempts(userId, labId);
        },

        recordLabGradeResult(userId, labId, submissionId, total, max, detailsJson) {
            return db.recordLabGradeResult(userId, labId, submissionId, total, max, detailsJson);
        },

        getInProgressLabs() {
            return db.prepare("SELECT * FROM submissions WHERE status = 'in_progress' AND type = 'lab'").all();
        },
    };
}

module.exports = { createSubmissionService };
