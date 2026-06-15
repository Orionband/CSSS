const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fixturesAvailable, loadPkaBuffer, loadLabConfig, TESTING_DIR } = require('../helpers/loadFixtures');
const { runGradeWithTiming } = require('../helpers/gradeTiming');

describe('PKA performance', () => {
    it('reports decrypt vs grade timings for test.pka', async (t) => {
        if (!fixturesAvailable()) {
            t.skip('testing/test.pka or testing/lab.conf not found');
            return;
        }

        const fileBuffer = loadPkaBuffer();
        const labConfig = loadLabConfig('tstrnd');
        const checkCount = labConfig.checks.length;

        const timing = await runGradeWithTiming({
            fileBuffer,
            labConfig,
            maxXmlMb: 25,
        });

        assert.ok(timing.decryptPipelineMs != null);
        assert.ok(timing.parseAndGradeMs != null);
        assert.ok(timing.result.grading);

        const fileSizeMb = (fileBuffer.length / (1024 * 1024)).toFixed(2);
        const summary = [
            `PKA performance (test.pka, ${checkCount} checks):`,
            `  decrypt+decompress: ${Math.round(timing.decryptPipelineMs)} ms`,
            `  parse+grade:        ${Math.round(timing.parseAndGradeMs)} ms`,
            `  total:             ${Math.round(timing.totalMs)} ms`,
            `  file size:         ${fileSizeMb} MB`,
            `  score:             ${timing.result.grading.total}/${timing.result.grading.max}`,
        ].join('\n');

        console.log(`\n${summary}\n`);
        t.diagnostic(summary);

        const perfPath = path.join(TESTING_DIR, '.perf-last.json');
        fs.writeFileSync(perfPath, JSON.stringify({
            at: new Date().toISOString(),
            checkCount,
            fileSizeBytes: fileBuffer.length,
            decryptPipelineMs: timing.decryptPipelineMs,
            parseAndGradeMs: timing.parseAndGradeMs,
            totalMs: timing.totalMs,
            score: timing.result.grading.total,
            max: timing.result.grading.max,
        }, null, 2));
    });
});
