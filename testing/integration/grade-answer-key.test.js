const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runGrade } = require('../../src/worker/gradeJob');
const { fixturesAvailable, loadPkaBuffer, loadLabConfig } = require('../helpers/loadFixtures');
const {
    expectedMaxScore,
    sumAwarded,
    clampedTotal,
    positiveChecks,
    penaltyChecks,
} = require('../helpers/expectedScore');

describe('answer-key grading integration', () => {
    it('grades test.pka against testing/lab.conf', async (t) => {
        if (!fixturesAvailable()) {
            t.skip('testing/test.pka or testing/lab.conf not found');
            return;
        }

        const labConfig = loadLabConfig('tstrnd');
        const result = await runGrade({
            fileBuffer: loadPkaBuffer(),
            labConfig,
            maxXmlMb: 25,
        }, () => {});

        const { grading } = result;
        const breakdown = grading.serverBreakdown;

        assert.equal(breakdown.length, labConfig.checks.length);
        assert.equal(grading.max, expectedMaxScore(labConfig));
        assert.equal(grading.total, clampedTotal(breakdown));
        assert.equal(grading.total, Math.max(0, sumAwarded(breakdown)));

        const penalty = breakdown.find((row) => row.device === 'BOS-PC1' && row.possible < 0);
        assert.ok(penalty, 'expected BOS-PC1 penalty check in breakdown');
        t.diagnostic(`BOS-PC1 penalty check passed=${penalty.passed} awarded=${penalty.awarded}`);

        const passedPositive = breakdown.filter((row) => row.possible > 0 && row.passed).length;
        const isAnswerKey = grading.total === expectedMaxScore(labConfig)
            && passedPositive === positiveChecks(labConfig).length;

        t.diagnostic(`Score: ${grading.total}/${grading.max} (${passedPositive}/${positiveChecks(labConfig).length} positive checks passed)`);

        if (isAnswerKey) {
            const failedPositive = breakdown.filter((row) => row.possible > 0 && !row.passed);
            assert.equal(failedPositive.length, 0, `Failed positive checks: ${failedPositive.map((r) => r.message).join('; ')}`);

            const hostname = breakdown.find((row) => row.device === 'PIX-NYC-R1' && /hostname/i.test(row.message));
            assert.ok(hostname?.passed, 'PIX-NYC-R1 hostname check should pass on answer-key PKA');

            const chiSw = breakdown.find((row) => row.device === 'PIX-CHI-SW1' && /access vlan 20/i.test(row.message));
            if (chiSw) assert.ok(chiSw.passed, 'PIX-CHI-SW1 dual-pass check should pass on answer-key PKA');
        } else {
            t.diagnostic('starter test.pka (expected): pipeline OK, positive checks fail, penalty may apply');
            assert.ok(breakdown.length > 0);
            assert.ok(penaltyChecks(labConfig).length > 0);
        }
    });
});
