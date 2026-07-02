const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../../src/database');

describe('recordLabGradeResult', () => {
    function seedSubmission(db, overrides = {}) {
        const user = db.prepare(
            'INSERT INTO users (username, email, password, unique_id) VALUES (?, ?, ?, ?)'
        ).run('u1', 'u1@test.local', 'hash', 'UID-0001');
        const defaults = {
            user_id: user.lastInsertRowid,
            unique_id: 'UID-0001',
            lab_id: 'lab1',
            status: 'in_progress',
            type: 'lab',
            score: 0,
            max_score: 0,
            details: '[]',
        };
        const row = { ...defaults, ...overrides };
        const info = db.prepare(
            'INSERT INTO submissions (user_id, unique_id, lab_id, status, type, score, max_score, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(row.user_id, row.unique_id, row.lab_id, row.status, row.type, row.score, row.max_score, row.details);
        return { userId: row.user_id, submissionId: info.lastInsertRowid, labId: row.lab_id };
    }

    it('updates an in-progress submission', () => {
        const db = createDatabase(':memory:', { silentChmod: true, skipStaleLockClear: true });
        const { userId, submissionId, labId } = seedSubmission(db);
        const details = JSON.stringify([{ message: 'ok', passed: true }]);
        const ok = db.recordLabGradeResult(userId, labId, submissionId, 8, 10, details);
        assert.equal(ok, true);
        const row = db.prepare('SELECT status, score, max_score FROM submissions WHERE id = ?').get(submissionId);
        assert.equal(row.status, 'completed');
        assert.equal(row.score, 8);
        assert.equal(row.max_score, 10);
    });

    it('reconciles an auto-closed 0/0 submission', () => {
        const db = createDatabase(':memory:', { silentChmod: true, skipStaleLockClear: true });
        const autoCloseDetails = JSON.stringify([{
            message: 'Auto-closed: Time limit expired.',
            device: 'N/A',
            possible: 0,
            awarded: 0,
            passed: false,
        }]);
        const { userId, submissionId, labId } = seedSubmission(db, {
            status: 'completed',
            details: autoCloseDetails,
        });
        const details = JSON.stringify([{ message: 'graded', passed: true }]);
        const ok = db.recordLabGradeResult(userId, labId, submissionId, 5, 10, details);
        assert.equal(ok, true);
        const row = db.prepare('SELECT score, max_score FROM submissions WHERE id = ?').get(submissionId);
        assert.equal(row.score, 5);
        assert.equal(row.max_score, 10);
    });

    it('reconciles quiz-style time expired details without a period', () => {
        const db = createDatabase(':memory:', { silentChmod: true, skipStaleLockClear: true });
        const autoCloseDetails = JSON.stringify([{ message: 'Time expired', correct: false }]);
        const { userId, submissionId, labId } = seedSubmission(db, {
            status: 'completed',
            details: autoCloseDetails,
        });
        const details = JSON.stringify([{ message: 'graded', passed: true }]);
        const ok = db.recordLabGradeResult(userId, labId, submissionId, 5, 10, details);
        assert.equal(ok, true);
    });

    it('does not reconcile a legitimate completed 0/0 grading result', () => {
        const db = createDatabase(':memory:', { silentChmod: true, skipStaleLockClear: true });
        const realZeroDetails = JSON.stringify([
            { message: 'Check A', device: 'R1', possible: 5, awarded: 0, passed: false },
            { message: 'Check B', device: 'R1', possible: 5, awarded: 0, passed: false },
        ]);
        const { userId, submissionId, labId } = seedSubmission(db, {
            status: 'completed',
            details: realZeroDetails,
        });
        const details = JSON.stringify([{ message: 'late grade', passed: true }]);
        const ok = db.recordLabGradeResult(userId, labId, submissionId, 5, 10, details);
        assert.equal(ok, false);
        const row = db.prepare('SELECT score, details FROM submissions WHERE id = ?').get(submissionId);
        assert.equal(row.score, 0);
        assert.equal(row.details, realZeroDetails);
    });
});
