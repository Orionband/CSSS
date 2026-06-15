const { performance } = require('perf_hooks');
const { runGrade } = require('../../src/worker/gradeJob');

async function runGradeWithTiming(job) {
    const events = [];
    const t0 = performance.now();
    let fileVerifiedAt = null;

    const emit = (msg) => {
        events.push({ ...msg, at: performance.now() - t0 });
        if (msg.type === 'file_verified') fileVerifiedAt = performance.now();
    };

    const result = await runGrade(job, emit);
    const tEnd = performance.now();

    const decryptPipelineMs = fileVerifiedAt != null ? fileVerifiedAt - t0 : null;
    const parseAndGradeMs = fileVerifiedAt != null ? tEnd - fileVerifiedAt : null;

    return {
        result,
        events,
        decryptPipelineMs,
        parseAndGradeMs,
        totalMs: tEnd - t0,
    };
}

module.exports = { runGradeWithTiming };
