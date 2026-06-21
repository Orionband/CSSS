const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildEntryForUser } = require('../../src/leaderboardScores');

const labs = [{ id: 'lab1', show_score: true }];
const quizzes = [{ id: 'quiz1', show_score: false }];
const allChallenges = [
    { id: 'lab1', show_score: true },
    { id: 'quiz1', show_score: false, type: 'quiz' },
];

describe('buildEntryForUser', () => {
    const scoreMap = { 1: { lab1: 50, quiz1: 20 } };
    const durationMap = { 1: { lab1: 120, quiz1: 60 } };

    it('builds totals from visible scores', () => {
        const entry = buildEntryForUser(
            { id: 1, username: 'alice', score_adjustment: 0, withheld: 0 },
            allChallenges,
            labs,
            quizzes,
            scoreMap,
            durationMap,
        );
        assert.equal(entry.raw_score, 50);
        assert.equal(entry.total_score, 50);
        assert.equal(entry.scores.lab1, 50);
        assert.equal(entry.scores.quiz1, '?');
        assert.equal(entry.total_time_seconds, 120);
    });

    it('applies score_adjustment', () => {
        const entry = buildEntryForUser(
            { id: 1, username: 'alice', score_adjustment: 10, withheld: 0 },
            [{ id: 'lab1', show_score: true }],
            [{ id: 'lab1', show_score: true }],
            [],
            { 1: { lab1: 40 } },
            {},
        );
        assert.equal(entry.raw_score, 40);
        assert.equal(entry.total_score, 50);
        assert.equal(entry.score_adjustment, 10);
    });

    it('marks withheld users with W', () => {
        const entry = buildEntryForUser(
            { id: 1, username: 'bob', score_adjustment: 0, withheld: 1 },
            [{ id: 'lab1', show_score: true }],
            [{ id: 'lab1', show_score: true }],
            [],
            { 1: { lab1: 30 } },
            {},
        );
        assert.equal(entry.raw_score, 30);
        assert.equal(entry.total_score, 'W');
        assert.equal(entry.scores.lab1, 'W');
    });

    it('returns null for zero-total users with no hidden scores', () => {
        const entry = buildEntryForUser(
            { id: 2, username: 'zero', score_adjustment: 0, withheld: 0 },
            [{ id: 'lab1', show_score: true }],
            [{ id: 'lab1', show_score: true }],
            [],
            { 2: { lab1: 0 } },
            {},
        );
        assert.equal(entry, null);
    });
});
