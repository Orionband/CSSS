const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateConfig } = require('../../src/config/validate');

describe('validateConfig', () => {
    it('rejects duplicate lab ids', () => {
        const result = validateConfig({
            labs: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }],
            quizzes: [],
        }, { skipAssetChecks: true });
        assert.equal(result.ok, false);
        assert.ok(result.errors.some((e) => e.includes('Duplicate lab id')));
    });

    it('rejects checks with no pass or passoverride conditions', () => {
        const result = validateConfig({
            labs: [{
                id: 'lab1',
                title: 'Lab',
                checks: [{ message: 'm', points: 1, device: 'R0' }],
            }],
            quizzes: [],
        }, { skipAssetChecks: true });
        assert.equal(result.ok, false);
        assert.ok(result.errors.some((e) => e.includes('pass or passoverride')));
    });

    it('accepts passoverride-only checks', () => {
        const result = validateConfig({
            labs: [{
                id: 'lab1',
                title: 'Lab',
                checks: [{
                    message: 'm',
                    points: 1,
                    device: 'R0',
                    passoverride: [{ type: 'ConfigMatch', source: 'running', context: 'global', value: 'x' }],
                }],
            }],
            quizzes: [],
        }, { skipAssetChecks: true });
        assert.equal(result.ok, true);
    });

    it('accepts minimal valid fixture', () => {
        const result = validateConfig({
            labs: [{
                id: 'lab1',
                title: 'Lab',
                checks: [{
                    message: 'm',
                    points: 1,
                    device: 'R0',
                    pass: [{ type: 'ConfigMatch', source: 'running', context: 'global', value: 'x' }],
                }],
            }],
            quizzes: [{
                id: 'q1',
                questions: [{ type: 'radio', answers: [{ text: 'a', correct: true }] }],
            }],
        }, { skipAssetChecks: true });
        assert.equal(result.ok, true);
    });

    it('rejects radio questions without exactly one correct answer', () => {
        const none = validateConfig({
            labs: [],
            quizzes: [{
                id: 'q1',
                questions: [{ type: 'radio', answers: [{ text: 'a' }, { text: 'b' }] }],
            }],
        }, { skipAssetChecks: true });
        assert.equal(none.ok, false);
        assert.ok(none.errors.some((e) => e.includes('exactly one correct answer')));

        const two = validateConfig({
            labs: [],
            quizzes: [{
                id: 'q1',
                questions: [{
                    type: 'radio',
                    answers: [{ text: 'a', correct: true }, { text: 'b', correct: true }],
                }],
            }],
        }, { skipAssetChecks: true });
        assert.equal(two.ok, false);
        assert.ok(two.errors.some((e) => e.includes('exactly one correct answer')));
    });

    it('rejects checkbox questions with no correct answers', () => {
        const result = validateConfig({
            labs: [],
            quizzes: [{
                id: 'q1',
                questions: [{
                    type: 'checkbox',
                    answers: [{ text: 'a' }, { text: 'b' }],
                }],
            }],
        }, { skipAssetChecks: true });
        assert.equal(result.ok, false);
        assert.ok(result.errors.some((e) => e.includes('at least one correct answer')));
    });

    it('rejects radio answers with empty text', () => {
        const result = validateConfig({
            labs: [],
            quizzes: [{
                id: 'q1',
                questions: [{ type: 'radio', answers: [{ text: '   ', correct: true }] }],
            }],
        }, { skipAssetChecks: true });
        assert.equal(result.ok, false);
        assert.ok(result.errors.some((e) => e.includes('missing or empty text')));
    });
});
