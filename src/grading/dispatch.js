const fs = require('fs');
const path = require('path');
const { elapsedSecondsSince } = require('../submissionDuration');
const { logServerError } = require('../auditLog');
const { invalidateLeaderboardCache } = require('../leaderboardCache');

function labConfigForWorker(lab) {
    return JSON.parse(JSON.stringify(lab));
}

function createGradingDispatcher({ db, graderPool, notifyGradingSlotsAvailable, lastStreamGradeAt, streamGradeKey, cleanupTempFile }) {
    function dispatchGradingTask(task) {
        const {
            socket, lockKey, socketUser, targetLab, inProgressId, maxXmlMb,
            tempFilePath, fileBuffer, transferList, streaming, finalSubmit, sessionTimestamp,
        } = task;
        const isStreamPoll = streaming && !finalSubmit;
        const retainXml = process.env.RETAIN_XML === 'true' && !isStreamPoll;

        let finished = false;
        const finishTask = () => {
            if (finished) return;
            finished = true;
            db.releaseLock(lockKey);
            cleanupTempFile(tempFilePath);
            notifyGradingSlotsAvailable();
        };

        const workerPayload = {
            labConfig: labConfigForWorker(targetLab),
            maxXmlMb,
            retainXml,
        };
        if (fileBuffer) workerPayload.fileBuffer = fileBuffer;
        if (tempFilePath) workerPayload.tempFilePath = tempFilePath;

        graderPool.enqueue(
            workerPayload,
            transferList,
            (msg) => {
                if (msg.type === 'progress') socket.emit('progress', msg);
                else if (msg.type === 'file_verified') socket.emit('file_verified');
                else if (msg.type === 'result') {
                    if (finished) return;
                    try {
                        const { grading } = msg;
                        const timestamp = Date.now();
                        const capturesDir = path.join(__dirname, '../../captures');

                        const detailsJson = JSON.stringify(grading.serverBreakdown);
                        let scoreRecorded = true;

                        if (isStreamPoll) {
                            const durationSeconds = sessionTimestamp
                                ? elapsedSecondsSince(sessionTimestamp)
                                : null;
                            db.prepare(
                                "INSERT INTO submissions (user_id, unique_id, lab_id, score, max_score, details, type, status, duration_seconds, stream_poll) VALUES (?, ?, ?, ?, ?, ?, 'lab', 'completed', ?, 1)"
                            ).run(
                                socketUser.id,
                                socketUser.unique_id,
                                targetLab.id,
                                grading.total,
                                grading.max,
                                detailsJson,
                                durationSeconds
                            );
                            lastStreamGradeAt.set(streamGradeKey(socketUser.id, targetLab.id), Date.now());
                        } else if (inProgressId) {
                            scoreRecorded = db.recordLabGradeResult(
                                socketUser.id,
                                targetLab.id,
                                inProgressId,
                                grading.total,
                                grading.max,
                                detailsJson
                            );
                        } else {
                            db.prepare('INSERT INTO submissions (user_id, unique_id, lab_id, score, max_score, details, type, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                                .run(socketUser.id, socketUser.unique_id, targetLab.id, grading.total, grading.max, detailsJson, 'lab', 'completed');
                        }

                        if (!scoreRecorded) {
                            socket.emit('err', 'Lab session ended before grading finished. No score was recorded.');
                            return;
                        }

                        invalidateLeaderboardCache();

                        if ((process.env.RETAIN_PKA === 'true' && !isStreamPoll) || retainXml) {
                            if (!fs.existsSync(capturesDir)) fs.mkdirSync(capturesDir, { recursive: true });
                            const safeTitle = targetLab.title.replace(/[^a-z0-9]/gi, '_');
                            const baseName = `${safeTitle}_${socketUser.unique_id}_${timestamp}`;
                            if (process.env.RETAIN_PKA === 'true' && tempFilePath && fs.existsSync(tempFilePath)) {
                                fs.copyFileSync(tempFilePath, path.join(capturesDir, `${baseName}.pka`));
                                fs.copyFileSync(tempFilePath, path.join(capturesDir, `${baseName}.pkt`));
                            }
                            if (retainXml && msg.xml) {
                                fs.writeFileSync(path.join(capturesDir, `${baseName}.xml`), msg.xml);
                            }
                        }

                        const payload = {
                            total: grading.total,
                            max: grading.max,
                            clientBreakdown: grading.clientBreakdown,
                            show_score: grading.show_score,
                            streaming: isStreamPoll,
                            final: Boolean(finalSubmit),
                        };

                        if (!grading.show_score) { delete payload.total; delete payload.max; }

                        socket.emit('result', payload);
                    } catch (e) {
                        logServerError({
                            userId: socketUser.id,
                            labId: targetLab.id,
                            detail: e && e.message ? e.message : String(e),
                            source: 'grading',
                        });
                        socket.emit('err', 'An internal processing error occurred.');
                    } finally {
                        finishTask();
                    }
                } else if (msg.type === 'error') {
                    logServerError({
                        userId: socketUser.id,
                        labId: targetLab.id,
                        detail: msg.auditDetail || msg.msg,
                        source: 'grading',
                    });
                    socket.emit('err', msg.msg);
                    finishTask();
                }
            },
            (errMsg) => {
                logServerError({
                    userId: socketUser.id,
                    labId: targetLab.id,
                    detail: `Worker pool failure: ${errMsg}`,
                    source: 'grading',
                });
                socket.emit('err', errMsg);
                finishTask();
            }
        );
    }

    return { dispatchGradingTask };
}

module.exports = { createGradingDispatcher, labConfigForWorker };
