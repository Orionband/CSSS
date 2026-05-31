const { parentPort, workerData } = require('worker_threads');
const { runGrade, sanitizeErrorMessage } = require('./gradeJob');

async function handleGradeMessage(msg) {
    const { jobId } = msg;
    const emit = (payload) => parentPort.postMessage({ ...payload, jobId });

    try {
        const result = await runGrade(msg, emit);
        parentPort.postMessage({ ...result, jobId });
    } catch (err) {
        parentPort.postMessage({ type: 'error', jobId, msg: sanitizeErrorMessage(err.message) });
    }
}

if (workerData && workerData.poolMode) {
    parentPort.on('message', (msg) => {
        if (!msg || msg.type !== 'grade') return;
        handleGradeMessage(msg);
    });
} else {
    (async () => {
        try {
            const result = await runGrade(workerData, (payload) => parentPort.postMessage(payload));
            parentPort.postMessage(result);
        } catch (err) {
            parentPort.postMessage({ type: 'error', msg: sanitizeErrorMessage(err.message) });
        }
    })();
}
