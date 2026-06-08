import { state } from './state.js';
import { renderLabResults } from './lab-results.js';
import { freezeLabTimer, unfreezeLabTimer } from './lab-timer.js';
import { clearBootstrapCache } from './auth.js';
import { playFinishSound, playGainSound, playLossSound, ensureNotificationPermission } from './sounds.js';

const STREAM_INTERVAL_MS = 120 * 1000;
const STREAM_HASH_POLL_MS = 20 * 1000;
const STREAM_DB_NAME = 'csss-stream-handles';
const STREAM_DB_STORE = 'handles';

let socketHandlersBound = false;
let fileInputListenerBound = false;
let submitListenerBound = false;
let streamPickListenerBound = false;

/** @type {{ fileData: ArrayBuffer, labId: string, fileSizeBytes: number, streaming: boolean, final: boolean } | null} */
let pendingUpload = null;

let streamFileHandle = null;
let streamCooldownTimerId = null;
let streamHashPollId = null;
let streamCountdownIntervalId = null;
let nextStreamWindowAt = 0;
let streamWatchActive = false;
let lastFileHash = null;
let lastUploadedHash = null;
let lastStreamScore = null;
let streamInFlight = false;
let finalSubmitPending = false;
let activeGradingFinal = false;

function streamDbKey(labId) {
    return `streamFile:${labId}`;
}

function resetPendingUpload() {
    pendingUpload = null;
}

function setStatus(message) {
    const statusText = document.getElementById('status');
    if (statusText) statusText.innerText = message;
}

function setProgressError() {
    const progressBar = document.getElementById('progress-bar');
    if (progressBar) progressBar.style.background = '#f44747';
}

function handleGradingFailure(message) {
    unfreezeLabTimer();
    resetPendingUpload();
    streamInFlight = false;
    finalSubmitPending = false;
    const wasStreamPoll = state.liveStreaming && !activeGradingFinal;
    activeGradingFinal = false;
    setStatus(message);
    setProgressError();
    if (state.liveStreaming && streamFileHandle) {
        setSubmitEnabled(true);
        if (wasStreamPoll) {
            lastUploadedHash = null;
            const waitSec = parseStreamRateLimitSeconds(message);
            if (waitSec !== null) {
                scheduleStreamCooldown(waitSec * 1000);
            } else {
                beginStreamWatch();
            }
        } else {
            updateStreamCountdownDisplay();
        }
    }
}

function setSubmitEnabled(enabled) {
    const btn = document.getElementById('btn-lab-submit');
    if (btn) btn.disabled = !enabled;
}

function getMaxUploadBytes() {
    const mb = state.labMaxUploadMb;
    if (!Number.isFinite(mb) || mb <= 0) return null;
    return mb * 1024 * 1024;
}

function uploadLimitErrorMessage() {
    const mb = state.labMaxUploadMb;
    return mb > 0
        ? `File exceeds the maximum allowed size for this lab (${mb} MB).`
        : 'File exceeds the maximum allowed size for this lab.';
}

function fileExceedsUploadLimit(sizeBytes) {
    const maxBytes = getMaxUploadBytes();
    return maxBytes !== null && sizeBytes > maxBytes;
}

function showUploadLimitError() {
    setStatus(uploadLimitErrorMessage());
    setProgressError();
}

function rejectStreamFilePick() {
    streamFileHandle = null;
    updateStreamFileLabel('');
    showUploadLimitError();
    setSubmitEnabled(false);
    clearPersistedStreamHandle(state.currentChallengeId).catch(() => {});
}

function supportsFileSystemAccess() {
    return 'showOpenFilePicker' in window;
}

async function hashArrayBuffer(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function openStreamDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(STREAM_DB_NAME, 1);
        req.onupgradeneeded = () => {
            req.result.createObjectStore(STREAM_DB_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function clearPersistedStreamHandle(labId) {
    if (!labId) return;
    try {
        const db = await openStreamDb();
        const tx = db.transaction(STREAM_DB_STORE, 'readwrite');
        tx.objectStore(STREAM_DB_STORE).delete(streamDbKey(labId));
    } catch {
        /* optional persistence */
    }
}

async function persistStreamHandle(labId, handle) {
    if (!labId) return;
    try {
        const db = await openStreamDb();
        const tx = db.transaction(STREAM_DB_STORE, 'readwrite');
        tx.objectStore(STREAM_DB_STORE).put(handle, streamDbKey(labId));
    } catch {
        /* optional persistence */
    }
}

async function loadPersistedStreamHandle(labId) {
    if (!labId) return;
    try {
        const db = await openStreamDb();
        const tx = db.transaction(STREAM_DB_STORE, 'readonly');
        const handle = await new Promise((resolve, reject) => {
            const req = tx.objectStore(STREAM_DB_STORE).get(streamDbKey(labId));
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        if (handle) {
            const file = await handle.getFile();
            if (fileExceedsUploadLimit(file.size)) {
                rejectStreamFilePick();
                return;
            }
            streamFileHandle = handle;
            lastFileHash = await hashArrayBuffer(await file.arrayBuffer());
            updateStreamFileLabel(file.name);
            setSubmitEnabled(true);
            startStreamPolling();
        }
    } catch {
        /* ignore */
    }
}

function updateStreamFileLabel(name) {
    const el = document.getElementById('stream-file-name');
    if (el) el.textContent = name ? `Streaming: ${name}` : '';
}

function formatStreamCountdown(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function showStreamCountdown(visible) {
    document.getElementById('stream-next-check')?.classList.toggle('hidden', !visible);
}

function updateStreamCountdownDisplay() {
    const el = document.getElementById('stream-next-check');
    if (!el || !state.liveStreaming || !streamFileHandle) return;

    if (streamInFlight) {
        el.textContent = 'Sending to server…';
        return;
    }

    if (streamWatchActive) {
        el.textContent = 'Waiting for you to save changes in Packet Tracer…';
        return;
    }

    const remaining = Math.max(0, Math.ceil((nextStreamWindowAt - Date.now()) / 1000));
    el.textContent = `Next grade window in ${formatStreamCountdown(remaining)}`;
}

function clearStreamCooldownTimer() {
    if (streamCooldownTimerId) {
        clearTimeout(streamCooldownTimerId);
        streamCooldownTimerId = null;
    }
}

function stopStreamHashPoll() {
    if (streamHashPollId) {
        clearInterval(streamHashPollId);
        streamHashPollId = null;
    }
}

function stopStreamWatch() {
    streamWatchActive = false;
    stopStreamHashPoll();
}

function scheduleStreamCooldown(delayMs = STREAM_INTERVAL_MS) {
    stopStreamWatch();
    clearStreamCooldownTimer();
    nextStreamWindowAt = Date.now() + delayMs;
    updateStreamCountdownDisplay();
    streamCooldownTimerId = setTimeout(() => {
        streamCooldownTimerId = null;
        beginStreamWatch();
    }, delayMs);
}

function beginStreamWatch() {
    if (!streamFileHandle || streamInFlight || !state.liveStreaming) return;

    streamWatchActive = true;
    updateStreamCountdownDisplay();
    checkHashForStream().catch(() => {});
    stopStreamHashPoll();
    streamHashPollId = setInterval(() => {
        checkHashForStream().catch(() => {});
    }, STREAM_HASH_POLL_MS);
}

function parseStreamRateLimitSeconds(message) {
    const match = String(message).match(/Please wait (\d+)s/);
    return match ? parseInt(match[1], 10) : null;
}

function startStreamCheckCountdown() {
    stopStreamCheckCountdown();
    showStreamCountdown(true);
    streamCountdownIntervalId = setInterval(updateStreamCountdownDisplay, 1000);
}

function stopStreamCheckCountdown() {
    if (streamCountdownIntervalId) {
        clearInterval(streamCountdownIntervalId);
        streamCountdownIntervalId = null;
    }
    showStreamCountdown(false);
}

export function stopStreaming() {
    clearStreamCooldownTimer();
    stopStreamWatch();
    stopStreamCheckCountdown();
    streamFileHandle = null;
    lastFileHash = null;
    lastUploadedHash = null;
    lastStreamScore = null;
    streamInFlight = false;
    finalSubmitPending = false;
    activeGradingFinal = false;
    nextStreamWindowAt = 0;
    updateStreamFileLabel('');
}

function prepareUploadUi() {
    document.getElementById('report')?.classList.add('hidden');

    const progress = document.getElementById('progress-container');
    const progressBar = document.getElementById('progress-bar');
    if (progress) progress.style.display = 'block';
    if (progressBar) {
        progressBar.style.width = '0%';
        progressBar.style.background = 'var(--accent)';
    }
}

function queueUpload(fileData, fileSizeBytes, { streaming = false, final = true } = {}) {
    streamInFlight = true;
    activeGradingFinal = false;

    if (pendingUpload) {
        state.socket.emit('cancel_grade_slot', {
            labId: pendingUpload.labId,
            _csrf: state.csrfToken,
        });
        resetPendingUpload();
    }

    prepareUploadUi();
    setStatus('Waiting for grader...');
    if (streaming && !final) updateStreamCountdownDisplay();

    pendingUpload = {
        fileData,
        labId: state.currentChallengeId,
        fileSizeBytes,
        streaming,
        final,
    };

    state.socket.emit('request_grade_slot', {
        labId: state.currentChallengeId,
        fileSizeBytes,
        streaming,
        final,
        _csrf: state.csrfToken,
    });
}

function stageFileFromInput(fileInput) {
    const file = fileInput.files[0];
    if (!file || state.currentChallengeType !== 'lab') return;

    if (fileExceedsUploadLimit(file.size)) {
        showUploadLimitError();
        setSubmitEnabled(false);
        fileInput.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = (evt) => {
        const fileData = evt.target.result;
        pendingUpload = {
            fileData,
            labId: state.currentChallengeId,
            fileSizeBytes: file.size,
            streaming: false,
            final: true,
        };
        setStatus(`Ready: ${file.name} — click Submit to grade.`);
        setSubmitEnabled(true);
    };
    reader.readAsArrayBuffer(file);
    fileInput.value = '';
}

async function pickStreamFile() {
    if (!supportsFileSystemAccess()) return;

    try {
        const handles = await window.showOpenFilePicker({
            multiple: false,
            types: [{
                description: 'Packet Tracer',
                accept: { 'application/octet-stream': ['.pka', '.pkt'] },
            }],
        });
        streamFileHandle = handles[0];
        const file = await streamFileHandle.getFile();
        if (fileExceedsUploadLimit(file.size)) {
            rejectStreamFilePick();
            return;
        }
        lastFileHash = await hashArrayBuffer(await file.arrayBuffer());
        updateStreamFileLabel(file.name);
        setSubmitEnabled(true);
        await persistStreamHandle(state.currentChallengeId, streamFileHandle);
        setStatus(`Watching ${file.name}. After each grade window opens, your next save in Packet Tracer triggers a grade.`);

        startStreamPolling();
    } catch (err) {
        if (err.name !== 'AbortError') {
            setStatus(`Error picking file: ${err.message}`);
            setProgressError();
        }
    }
}

function startStreamPolling() {
    clearStreamCooldownTimer();
    stopStreamWatch();
    startStreamCheckCountdown();
    scheduleStreamCooldown();
}

async function checkHashForStream() {
    if (!streamFileHandle || streamInFlight || !state.liveStreaming || !streamWatchActive) return;

    const file = await streamFileHandle.getFile();
    if (fileExceedsUploadLimit(file.size)) {
        showUploadLimitError();
        setSubmitEnabled(false);
        return;
    }

    const buffer = await file.arrayBuffer();
    const hash = await hashArrayBuffer(buffer);

    if (hash === lastFileHash) return;
    if (hash === lastUploadedHash) return;

    lastUploadedHash = hash;
    stopStreamWatch();
    queueUpload(buffer, file.size, { streaming: true, final: false });
}

function confirmSubmit() {
    if (state.liveStreaming) {
        return window.confirm(
            'Are you sure you want to submit your Packet Tracer file?\n\n' +
            'This is your final submission. It ends your lab session and counts as your official attempt. ' +
            'Automatic stream grades while you work do not close the lab; only Submit does.\n\n' +
            'Click OK to confirm and submit.'
        );
    }

    return window.confirm(
        'Are you sure you want to submit your Packet Tracer file?\n\n' +
        'Your file will be graded and this submission cannot be undone.\n\n' +
        'Click OK to confirm and submit.'
    );
}

async function submitCurrentFile() {
    ensureNotificationPermission();

    if (state.liveStreaming) {
        if (!streamFileHandle) {
            setStatus('Pick a file to stream before submitting.');
            return;
        }
        if (!confirmSubmit()) return;

        const file = await streamFileHandle.getFile();
        if (fileExceedsUploadLimit(file.size)) {
            showUploadLimitError();
            return;
        }
        const buffer = await file.arrayBuffer();
        finalSubmitPending = true;
        queueUpload(buffer, file.size, { streaming: true, final: true });
        return;
    }

    if (!pendingUpload?.fileData) {
        setStatus('Select a file before submitting.');
        return;
    }

    if (!confirmSubmit()) return;

    queueUpload(pendingUpload.fileData, pendingUpload.fileSizeBytes, {
        streaming: false,
        final: true,
    });
}

function onLabFileInputChange(e) {
    if (e.target.id !== 'f') return;
    stageFileFromInput(e.target);
}

function handleResult(data) {
    const progressBar = document.getElementById('progress-bar');
    const statusText = document.getElementById('status');
    const checksList = document.getElementById('checks-list');
    const scoreBox = document.getElementById('final-score');
    if (!checksList) return;

    const isStreamPoll = data.streaming === true;
    const isFinal = data.final === true;

    resetPendingUpload();

    if (progressBar) progressBar.style.width = '100%';
    if (statusText) statusText.innerText = isStreamPoll ? 'Stream grade complete' : 'Done';
    checksList.innerHTML = '';
    document.getElementById('report')?.classList.remove('hidden');

    if (scoreBox) {
        scoreBox.innerText = data.show_score ? `${data.total} / ${data.max}` : 'Hidden';
    }

    if (data.clientBreakdown === null) {
        checksList.innerHTML = "<div class='challenges-empty'>Feedback hidden.</div>";
    } else {
        renderLabResults(checksList, data.clientBreakdown);
    }

    clearBootstrapCache();
    streamInFlight = false;
    activeGradingFinal = false;

    if (isStreamPoll) {
        if (streamFileHandle) {
            streamFileHandle.getFile()
                .then((f) => f.arrayBuffer())
                .then((buf) => hashArrayBuffer(buf))
                .then((h) => {
                    lastFileHash = h;
                    lastUploadedHash = null;
                })
                .catch(() => {});
        } else {
            lastUploadedHash = null;
        }

        if (data.show_score && typeof data.total === 'number') {
            if (lastStreamScore !== null && data.total > lastStreamScore) {
                playGainSound({
                    title: 'Gained points',
                    body: 'You gained points.',
                });
            } else if (lastStreamScore !== null && data.total < lastStreamScore) {
                playLossSound({
                    title: 'Lost points',
                    body: 'You lost points.',
                });
            }
            lastStreamScore = data.total;
        }
        setSubmitEnabled(Boolean(streamFileHandle));
        scheduleStreamCooldown();
    } else {
        if (isFinal && finalSubmitPending) {
            stopStreaming();
            finalSubmitPending = false;
        }
        setSubmitEnabled(false);
    }

    if (!isStreamPoll) {
        playFinishSound({
            title: 'Lab graded',
            body: 'Your lab submission has been graded.',
        });
    }
}

export function initUploadHandlers() {
    if (!socketHandlersBound) {
        state.socket.on('progress', (d) => {
            const progressBar = document.getElementById('progress-bar');
            const statusText = document.getElementById('status');
            if (!progressBar || !statusText) return;
            const pct = parseFloat(d.percent) || 0;
            progressBar.style.width = pct + '%';
            statusText.innerText = `${d.stage} (${Math.round(pct)}%)`;
        });

        state.socket.on('result', handleResult);

        state.socket.on('file_verified', () => {
            const shouldFreeze = !state.liveStreaming || activeGradingFinal;
            if (shouldFreeze) freezeLabTimer();
        });

        state.socket.on('grade_slot_waiting', (data) => {
            const position = parseInt(data?.position, 10);
            if (position > 0) {
                setStatus(`Waiting for grader (position ${position})...`);
            } else {
                setStatus('Waiting for grader...');
            }
        });

        state.socket.on('grade_slot_ready', (data) => {
            if (!pendingUpload) {
                handleGradingFailure('Error: No file ready to upload.');
                return;
            }

            if (data?.labId !== pendingUpload.labId) {
                handleGradingFailure('Error: Lab mismatch. Please submit again.');
                return;
            }

            if (!data?.slotToken) {
                handleGradingFailure('Error: Invalid grading slot. Please submit again.');
                return;
            }

            const uploadPayload = { ...pendingUpload };
            activeGradingFinal = uploadPayload.final === true;
            setStatus('Uploading...');
            state.socket.emit('upload_file', {
                fileData: uploadPayload.fileData,
                labId: uploadPayload.labId,
                fileSizeBytes: uploadPayload.fileSizeBytes,
                slotToken: data.slotToken,
                streaming: uploadPayload.streaming,
                final: uploadPayload.final,
                _csrf: state.csrfToken,
            });
            setStatus('Queued...');
        });

        state.socket.on('grade_slot_expired', (data) => {
            handleGradingFailure('Error: ' + (data?.message || 'Upload window expired. Please submit again.'));
        });

        state.socket.on('err', (msg) => {
            handleGradingFailure('Error: ' + msg);
        });

        socketHandlersBound = true;
    }

    if (!fileInputListenerBound) {
        document.addEventListener('change', onLabFileInputChange);
        fileInputListenerBound = true;
    }

    if (!submitListenerBound) {
        document.getElementById('btn-lab-submit')?.addEventListener('click', () => {
            submitCurrentFile().catch((err) => {
                setStatus(`Error: ${err.message}`);
                setProgressError();
            });
        });
        submitListenerBound = true;
    }

    if (!streamPickListenerBound) {
        document.getElementById('stream-pick-area')?.addEventListener('click', () => {
            pickStreamFile().catch(() => {});
        });
        streamPickListenerBound = true;
    }
}

export function configureLabUploadMode(liveStreaming) {
    state.liveStreaming = liveStreaming === true;
    stopStreaming();
    resetPendingUpload();
    setSubmitEnabled(false);

    const uploadArea = document.getElementById('upload-area-box');
    const streamArea = document.getElementById('stream-pick-area');
    const saveNote = document.getElementById('stream-save-note');
    const unsupported = document.getElementById('stream-unsupported');
    const instructions = document.getElementById('lab-upload-instructions');

    if (state.liveStreaming) {
        uploadArea?.classList.add('hidden');
        saveNote?.classList.remove('hidden');
        if (instructions) {
            instructions.textContent = 'Use a Chromium-based browser (Chrome, Edge, or Opera). Pick your Packet Tracer file to stream grades while you work. Submit is your real, final submission when you are finished.';
        }
        if (saveNote) {
            saveNote.textContent = 'Save your Packet Tracer file often. A new grade window opens every 2 minutes after each successful stream grade; once open, your next save triggers grading. Submit ends the lab and counts as your official attempt — stream grades alone do not.';
        }

        if (!supportsFileSystemAccess()) {
            streamArea?.classList.add('hidden');
            unsupported?.classList.remove('hidden');
            if (unsupported) {
                unsupported.textContent = 'Live streaming requires a Chromium-based browser (Chrome, Edge, or Opera).';
            }
            return;
        }

        unsupported?.classList.add('hidden');
        streamArea?.classList.remove('hidden');
        loadPersistedStreamHandle(state.currentChallengeId).catch(() => {});
        return;
    }

    uploadArea?.classList.remove('hidden');
    streamArea?.classList.add('hidden');
    saveNote?.classList.add('hidden');
    unsupported?.classList.add('hidden');
    if (instructions) {
        instructions.textContent = 'Select your Packet Tracer file, then click Submit to be graded.';
    }
}
