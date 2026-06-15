const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    MAX_AUTH_ATTEMPTS_PER_SOCKET,
    getSocketClientIp,
    authAttemptsByIp,
    uploadAttemptsByUser,
    registerSocketConnection,
    canAddUserSocket,
} = require('../socketLimits');
const { resolveUploadMb } = require('../limits');
const { elapsedSecondsSince } = require('../submissionDuration');
const { logServerError } = require('../auditLog');

const STREAM_MIN_INTERVAL_MS = 115 * 1000;

function parseDeclaredFileSize(raw, maxMb) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null;
    const maxBytes = maxMb * 1024 * 1024;
    if (n > maxBytes) return null;
    return n;
}

function parsePacketBool(value) {
    return value === true;
}

function streamGradeKey(userId, labId) {
    return `${userId}:${labId}`;
}

function mountGradingSockets(io, deps) {
    const {
        db,
        getConfig,
        isWindowOpen,
        gradeAdmission,
        notifyGradingSlotsAvailable,
        validateReloadedSession,
        labSessionService,
        dispatchGradingTask,
        cleanupTempFile,
        lastStreamGradeAt,
        shuttingDown,
    } = deps;

    global.activeUserSockets = global.activeUserSockets || new Map();

    io.on('connection', (socket) => {
        if (!registerSocketConnection(socket)) {
            socket.emit('err', 'Too many connections from this address.');
            socket.disconnect(true);
            return;
        }

        let socketUser = null;
        let isAuthenticated = false;
        let authInProgress = false;
        let authAttempts = 0;
        const clientIp = getSocketClientIp(socket);
        let socketSessionTracked = false;

        socket.on('disconnect', () => {
            gradeAdmission.removeSocket(socket.id);
            notifyGradingSlotsAvailable();
        });

        socket.on('authenticate', () => {
            if (authInProgress) return;
            if (authAttempts >= MAX_AUTH_ATTEMPTS_PER_SOCKET) {
                return socket.emit('auth_fail');
            }
            if (!authAttemptsByIp(clientIp)) {
                return socket.emit('auth_fail');
            }
            authAttempts++;
            authInProgress = true;

            socket.request.session.reload((reloadErr) => {
                const failAuth = () => {
                    authInProgress = false;
                    isAuthenticated = false;
                    socketUser = null;
                    socket.emit('auth_fail');
                };

                if (reloadErr) return failAuth();

                const sess = socket.request.session;
                const user = validateReloadedSession(db, sess);
                if (!user) {
                    return failAuth();
                }

                if (!canAddUserSocket(user.id)) {
                    authInProgress = false;
                    return socket.emit('auth_fail');
                }

                socketUser = user;
                isAuthenticated = true;
                authInProgress = false;
                socket.data.requestId = socket.data.requestId || deps.generateRequestId?.();

                if (!global.activeUserSockets.has(user.id)) {
                    global.activeUserSockets.set(user.id, new Set());
                }
                global.activeUserSockets.get(user.id).add(socket);

                if (!socketSessionTracked) {
                    socketSessionTracked = true;
                    const trackedUserId = user.id;
                    socket.on('disconnect', () => {
                        const userSet = global.activeUserSockets.get(trackedUserId);
                        if (userSet) {
                            userSet.delete(socket);
                            if (userSet.size === 0) {
                                global.activeUserSockets.delete(trackedUserId);
                            }
                        }
                    });
                }

                socket.emit('auth_success', user.unique_id);
            });
        });

        socket.on('cancel_grade_slot', (packet) => {
            if (!isAuthenticated || !socketUser) return;
            if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return;

            const rawLabId = typeof packet.labId === 'string' ? packet.labId.trim() : '';
            if (!rawLabId) return;

            socket.request.session.reload((reloadErr) => {
                if (reloadErr) return;
                const sess = socket.request.session;
                if (!sess?.userId || sess.userId !== socketUser.id) return;
                if (!validateReloadedSession(db, sess)) return;
                if (!packet._csrf || packet._csrf !== sess.csrfToken) return;

                gradeAdmission.cancelWaiting(socket.id, socketUser.id, rawLabId);
            });
        });

        socket.on('request_grade_slot', (packet) => {
            if (shuttingDown?.()) return socket.emit('err', 'Server is shutting down.');
            if (!isAuthenticated || !socketUser) return socket.emit('err', 'Unauthorized');

            if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
                return socket.emit('err', 'Invalid request.');
            }

            const rawLabIdEarly = typeof packet.labId === 'string' ? packet.labId.trim() : '';
            if (!rawLabIdEarly) {
                return socket.emit('err', 'Invalid Lab ID.');
            }

            const cfgEarly = getConfig();
            const labsEarly = cfgEarly.labs || [];
            const targetLabEarly = labsEarly.find((l) => l.id === rawLabIdEarly);
            if (!targetLabEarly) return socket.emit('err', 'Invalid Lab ID.');

            const labMaxMbEarly = resolveUploadMb(targetLabEarly.max_upload_mb);
            const declaredSize = parseDeclaredFileSize(packet.fileSizeBytes, labMaxMbEarly);
            if (declaredSize === null) {
                return socket.emit('err', 'File exceeds the maximum allowed size for this lab.');
            }

            const userIdEarly = socketUser.id;
            if (!uploadAttemptsByUser(String(userIdEarly))) {
                return socket.emit('err', 'Too many submissions. You can upload at most 8 files per minute.');
            }

            socket.request.session.reload((reloadErr) => {
                if (reloadErr) {
                    isAuthenticated = false;
                    socketUser = null;
                    return socket.emit('err', 'Session expired. Please refresh and log in again.');
                }

                const sess = socket.request.session;
                if (!sess?.userId || sess.userId !== socketUser.id) {
                    isAuthenticated = false;
                    socketUser = null;
                    return socket.emit('err', 'Session expired. Please refresh and log in again.');
                }

                if (!validateReloadedSession(db, sess)) {
                    isAuthenticated = false;
                    socketUser = null;
                    return socket.emit('err', 'Session expired. Please refresh and log in again.');
                }

                if (!packet._csrf || packet._csrf !== sess.csrfToken) {
                    return socket.emit('err', 'Invalid CSRF token. Please refresh the page.');
                }

                const userId = userIdEarly;
                const labId = rawLabIdEarly;
                const targetLab = targetLabEarly;
                const lockKey = `lab_${userId}_${labId}`;

                if (!isWindowOpen(targetLab)) {
                    return socket.emit('err', 'Submissions are currently closed outside of the competition window.');
                }

                if (labSessionService.isSubmissionLockHeld(lockKey)) {
                    return socket.emit('err', 'A submission is currently processing. Please wait.');
                }

                const activeSession = labSessionService.getActiveSession(userId, labId);
                if (!activeSession) {
                    return socket.emit('err', 'No active lab session. Please start the lab first.');
                }

                const uploadTimeLimitMinutes = labSessionService.getTimeLimitMinutes(targetLab);
                if (labSessionService.isTimeExpired(activeSession.timestamp, uploadTimeLimitMinutes)) {
                    return socket.emit('err', 'Time limit expired. Your submission was rejected.');
                }

                const streaming = parsePacketBool(packet.streaming);
                const finalSubmit = parsePacketBool(packet.final);

                if (streaming && targetLab.live_streaming !== true) {
                    return socket.emit('err', 'Live streaming is not enabled for this lab.');
                }

                if (streaming && !finalSubmit) {
                    const sk = streamGradeKey(userId, labId);
                    const lastAt = lastStreamGradeAt.get(sk);
                    if (lastAt && Date.now() - lastAt < STREAM_MIN_INTERVAL_MS) {
                        const waitSec = Math.ceil((STREAM_MIN_INTERVAL_MS - (Date.now() - lastAt)) / 1000);
                        return socket.emit('err', `Please wait ${waitSec}s before the next stream grade.`);
                    }
                }

                const result = gradeAdmission.enqueue({
                    socket,
                    userId,
                    labId,
                    fileSizeBytes: declaredSize,
                });

                if (!result.ok) {
                    return socket.emit('err', result.error);
                }

                socket.emit('grade_slot_waiting', { position: result.position });
            });
        });

        socket.on('upload_file', (packet) => {
            if (shuttingDown?.()) return socket.emit('err', 'Server is shutting down.');
            if (!isAuthenticated || !socketUser) return socket.emit('err', 'Unauthorized');

            if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
                return socket.emit('err', 'Invalid upload packet.');
            }

            if (typeof packet.slotToken !== 'string' || !packet.slotToken) {
                return socket.emit('err', 'Missing grading slot. Please submit again.');
            }

            const fileDataEarly = packet.fileData;
            if (!fileDataEarly || (!Buffer.isBuffer(fileDataEarly) && typeof fileDataEarly !== 'string')) {
                return socket.emit('err', 'Invalid file format.');
            }
            const cfgEarly = getConfig();
            const labsEarly = cfgEarly.labs || [];
            const rawLabIdEarly = typeof packet.labId === 'string' ? packet.labId.trim() : '';
            if (!rawLabIdEarly) {
                return socket.emit('err', 'Invalid Lab ID.');
            }
            const targetLabEarly = labsEarly.find((l) => l.id === rawLabIdEarly);
            if (!targetLabEarly) return socket.emit('err', 'Invalid Lab ID.');
            const labMaxMbEarly = resolveUploadMb(targetLabEarly.max_upload_mb);
            if (Buffer.byteLength(fileDataEarly) > labMaxMbEarly * 1024 * 1024) {
                return socket.emit('err', 'File exceeds the maximum allowed size for this lab.');
            }
            const userIdEarly = socketUser.id;

            socket.request.session.reload((reloadErr) => {
                if (reloadErr) {
                    isAuthenticated = false;
                    socketUser = null;
                    return socket.emit('err', 'Session expired. Please refresh and log in again.');
                }

                const sess = socket.request.session;
                if (!sess?.userId || sess.userId !== socketUser.id) {
                    isAuthenticated = false;
                    socketUser = null;
                    return socket.emit('err', 'Session expired. Please refresh and log in again.');
                }

                if (!validateReloadedSession(db, sess)) {
                    isAuthenticated = false;
                    socketUser = null;
                    return socket.emit('err', 'Session expired. Please refresh and log in again.');
                }

                const clientToken = packet._csrf;
                if (!clientToken || clientToken !== sess.csrfToken) {
                    return socket.emit('err', 'Invalid CSRF token. Please refresh the page.');
                }

                const fileData = fileDataEarly;
                const labId = rawLabIdEarly;
                const userId = userIdEarly;
                const targetLab = targetLabEarly;

                if (!isWindowOpen(targetLab)) {
                    return socket.emit('err', 'Submissions are currently closed outside of the competition window.');
                }

                const lockKey = `lab_${userId}_${labId}`;
                if (!db.acquireLock(lockKey)) {
                    return socket.emit('err', 'A submission is currently processing. Please wait.');
                }

                const actualFileSize = Buffer.byteLength(fileDataEarly);
                const slotResult = gradeAdmission.consumeSlot(packet.slotToken, {
                    socketId: socket.id,
                    userId,
                    labId,
                    fileSizeBytes: actualFileSize,
                });
                if (!slotResult.ok) {
                    db.releaseLock(lockKey);
                    notifyGradingSlotsAvailable();
                    return socket.emit('err', slotResult.error);
                }

                let tempFilePath;
                try {
                    let inProgressId = null;
                    const activeSession = labSessionService.getActiveSession(userId, labId);

                    if (!activeSession) {
                        db.releaseLock(lockKey);
                        notifyGradingSlotsAvailable();
                        return socket.emit('err', 'No active lab session. Please start the lab first.');
                    }

                    const uploadTimeLimitMinutes = labSessionService.getTimeLimitMinutes(targetLab);
                    if (labSessionService.isTimeExpired(activeSession.timestamp, uploadTimeLimitMinutes)) {
                        labSessionService.closeExpiredSession(activeSession.id, activeSession.timestamp, 'Time expired on submission.');
                        db.releaseLock(lockKey);
                        notifyGradingSlotsAvailable();
                        return socket.emit('err', 'Time limit expired. Your submission was rejected.');
                    }
                    inProgressId = activeSession.id;
                    const streaming = parsePacketBool(packet.streaming);
                    const finalSubmit = parsePacketBool(packet.final);
                    const isStreamPoll = streaming && !finalSubmit;

                    if (streaming && targetLab.live_streaming !== true) {
                        db.releaseLock(lockKey);
                        notifyGradingSlotsAvailable();
                        return socket.emit('err', 'Live streaming is not enabled for this lab.');
                    }

                    const uploadDurationSeconds = elapsedSecondsSince(activeSession.timestamp);
                    if (!isStreamPoll) {
                        db.prepare('UPDATE submissions SET duration_seconds = ? WHERE id = ? AND status = \'in_progress\'')
                            .run(uploadDurationSeconds, inProgressId);
                    }

                    const maxXmlMb = targetLab.max_xml_output_mb || 20;
                    const retainPka = process.env.RETAIN_PKA === 'true' && !isStreamPoll;
                    const fileBuffer = Buffer.isBuffer(fileData) ? fileData : Buffer.from(fileData);

                    const task = {
                        socket,
                        lockKey,
                        socketUser,
                        targetLab,
                        inProgressId,
                        maxXmlMb,
                        tempFilePath: null,
                        fileBuffer: null,
                        transferList: [],
                        streaming,
                        finalSubmit,
                        sessionTimestamp: activeSession.timestamp,
                    };

                    if (retainPka) {
                        const tmpDir = os.tmpdir();
                        tempFilePath = path.join(tmpDir, `csss_${crypto.randomBytes(16).toString('hex')}.tmp`);
                        task.tempFilePath = tempFilePath;

                        fs.writeFile(tempFilePath, fileBuffer, (writeErr) => {
                            if (writeErr) {
                                logServerError({
                                    userId: socketUser.id,
                                    labId: targetLab.id,
                                    detail: writeErr.message || 'Failed to save upload to temp file',
                                    source: 'upload',
                                });
                                db.releaseLock(lockKey);
                                notifyGradingSlotsAvailable();
                                return socket.emit('err', 'An internal error occurred while saving the file.');
                            }
                            dispatchGradingTask(task);
                        });
                    } else {
                        task.fileBuffer = fileBuffer;
                        task.transferList = [
                            fileBuffer.buffer.slice(
                                fileBuffer.byteOffset,
                                fileBuffer.byteOffset + fileBuffer.byteLength
                            ),
                        ];
                        dispatchGradingTask(task);
                    }
                } catch (err) {
                    logServerError({
                        userId: socketUser?.id,
                        labId: targetLab?.id,
                        detail: err && err.message ? err.message : String(err),
                        source: 'upload',
                    });
                    db.releaseLock(lockKey);
                    cleanupTempFile(tempFilePath);
                    notifyGradingSlotsAvailable();
                    socket.emit('err', 'An internal error occurred.');
                }
            });
        });
    });
}

module.exports = { mountGradingSockets, STREAM_MIN_INTERVAL_MS, streamGradeKey };
