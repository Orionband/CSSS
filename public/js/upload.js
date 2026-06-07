import { state } from './state.js';
import { renderLabResults } from './lab-results.js';
import { freezeLabTimer } from './lab-timer.js';
import { clearBootstrapCache } from './auth.js';
import { playFinishSound, playGainSound, ensureNotificationPermission } from './sounds.js';

const STREAM_INTERVAL_MS = 120 * 1000;
const STREAM_DB_NAME = 'csss-stream-handles';
const STREAM_DB_STORE = 'handles';

let socketHandlersBound = false;
let fileInputListenerBound = false;
let submitListenerBound = false;
let streamPickListenerBound = false;

/** @type {{ fileData: ArrayBuffer, labId: string, fileSizeBytes: number, streaming: boolean, final: boolean } | null} */
let pendingUpload = null;

let streamFileHandle = null;
let streamTimerId = null;
let streamCountdownIntervalId = null;
let nextStreamCheckAt = 0;
let lastFileHash = null;
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

function setSubmitEnabled(enabled) {
    const btn = document.getElementById('btn-lab-submit');
    if (btn) btn.disabled = !enabled;
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
            streamFileHandle = handle;
            const file = await handle.getFile();
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

    const remaining = Math.max(0, Math.ceil((nextStreamCheckAt - Date.now()) / 1000));
    el.textContent = `Next server check in ${formatStreamCountdown(remaining)}`;
}

function resetStreamCheckCountdown() {
    nextStreamCheckAt = Date.now() + STREAM_INTERVAL_MS;
    updateStreamCountdownDisplay();
}

function startStreamCheckCountdown() {
    stopStreamCheckCountdown();
    resetStreamCheckCountdown();
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
    if (streamTimerId) {
        clearInterval(streamTimerId);
        streamTimerId = null;
    }
    stopStreamCheckCountdown();
    streamFileHandle = null;
    lastFileHash = null;
    lastStreamScore = null;
    streamInFlight = false;
    finalSubmitPending = false;
    activeGradingFinal = false;
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
        lastFileHash = await hashArrayBuffer(await file.arrayBuffer());
        updateStreamFileLabel(file.name);
        setSubmitEnabled(true);
        await persistStreamHandle(state.currentChallengeId, streamFileHandle);
        setStatus(`Watching ${file.name}. Every 2 minutes the file is checked; grades run only after you save changes in Packet Tracer.`);

        startStreamPolling();
    } catch (err) {
        if (err.name !== 'AbortError') {
            setStatus(`Error picking file: ${err.message}`);
            setProgressError();
        }
    }
}

function startStreamPolling() {
    if (streamTimerId) clearInterval(streamTimerId);
    startStreamCheckCountdown();
    streamTimerId = setInterval(() => {
        readAndMaybeStream().catch(() => {});
    }, STREAM_INTERVAL_MS);
}

async function readAndMaybeStream() {
    if (!streamFileHandle || streamInFlight || !state.liveStreaming) return;

    resetStreamCheckCountdown();

    const file = await streamFileHandle.getFile();
    const buffer = await file.arrayBuffer();
    const hash = await hashArrayBuffer(buffer);

    if (hash === lastFileHash) {
        setStatus(`No file changes since last check (${file.name}).`);
        return;
    }

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
    if (isStreamPoll) updateStreamCountdownDisplay();

    if (isStreamPoll) {
        if (streamFileHandle) {
            streamFileHandle.getFile()
                .then((f) => f.arrayBuffer())
                .then((buf) => hashArrayBuffer(buf))
                .then((h) => { lastFileHash = h; })
                .catch(() => {});
        }

        if (data.show_score && typeof data.total === 'number') {
            if (lastStreamScore !== null && data.total > lastStreamScore) {
                const gained = data.total - lastStreamScore;
                playGainSound({
                    title: 'Gained points',
                    body: `Your score increased by ${gained} point${gained === 1 ? '' : 's'}.`,
                });
            }
            lastStreamScore = data.total;
        }
        setSubmitEnabled(Boolean(streamFileHandle));
        return;
    }

    if (isFinal && finalSubmitPending) {
        stopStreaming();
        finalSubmitPending = false;
    }
    setSubmitEnabled(false);
    playFinishSound({
        title: 'Lab graded',
        body: 'Your lab submission has been graded.',
    });
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
                setStatus('Error: No file ready to upload.');
                setProgressError();
                streamInFlight = false;
                finalSubmitPending = false;
                return;
            }

            if (data?.labId !== pendingUpload.labId) {
                setStatus('Error: Lab mismatch. Please submit again.');
                setProgressError();
                resetPendingUpload();
                streamInFlight = false;
                finalSubmitPending = false;
                return;
            }

            if (!data?.slotToken) {
                setStatus('Error: Invalid grading slot. Please submit again.');
                setProgressError();
                resetPendingUpload();
                streamInFlight = false;
                finalSubmitPending = false;
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
            resetPendingUpload();
            streamInFlight = false;
            finalSubmitPending = false;
            setStatus('Error: ' + (data?.message || 'Upload window expired. Please submit again.'));
            setProgressError();
        });

        state.socket.on('err', (msg) => {
            resetPendingUpload();
            streamInFlight = false;
            finalSubmitPending = false;
            setStatus('Error: ' + msg);
            setProgressError();
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
            saveNote.textContent = 'Save your Packet Tracer file often. Live streaming checks every 2 minutes and grades only when the saved file changes. Submit ends the lab and counts as your official attempt — stream grades alone do not.';
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
