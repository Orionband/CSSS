import { state } from './state.js';
import { securePost, showAlert, apiFetch, NETWORK_ERROR_MESSAGE, isNetworkError, showNetworkError } from './utils.js';
import { clearBootstrapCache } from './auth.js';
import { createLabWarnScheduler, ensureNotificationPermission } from './sounds.js';
import { configureLabUploadMode, stopStreaming, supportsFileSystemAccess } from './upload.js';
import { freezeLabTimer, startLabTimer, unfreezeLabTimer } from './lab-timer.js';

export { renderLabResults } from './lab-results.js';
export { freezeLabTimer, unfreezeLabTimer };

function setLabLoading(loading) {
    document.getElementById('lab-loading')?.classList.toggle('hidden', !loading);
    if (loading) {
        document.getElementById('lab-start-screen')?.classList.add('hidden');
        document.getElementById('lab-active-screen')?.classList.add('hidden');
        document.getElementById('report')?.classList.add('hidden');
    }
}

function setLabStats(data) {
    document.getElementById('lab-stat-time').textContent =
        data.time_limit_minutes > 0 ? `${data.time_limit_minutes} Minutes` : 'Unlimited';
    document.getElementById('lab-stat-attempts').textContent =
        data.max_submissions > 0 ? `${data.attempts_taken} / ${data.max_submissions}` : `${data.attempts_taken} (Unlimited)`;
    document.getElementById('lab-stat-pka').textContent =
        data.has_pka_file ? 'Provided after start' : 'None';
}

function showLabIntro() {
    document.getElementById('lab-start-screen')?.classList.remove('hidden');
    document.getElementById('lab-active-screen')?.classList.add('hidden');
    document.getElementById('report')?.classList.add('hidden');
}

const BROWSER_WARNING_MESSAGE =
    'This lab uses live streaming, which requires a Chromium-based browser (Chrome, Edge, or Opera). Switch browsers before starting.';

function updateLabBrowserWarning(liveStreaming) {
    const warning = document.getElementById('lab-browser-warning');
    const startBtn = document.getElementById('btn-start-lab');
    if (!warning) return;

    if (liveStreaming && !supportsFileSystemAccess()) {
        warning.textContent = BROWSER_WARNING_MESSAGE;
        warning.classList.remove('hidden');
        startBtn?.setAttribute('disabled', 'disabled');
        startBtn?.setAttribute('title', 'Requires a Chromium-based browser');
        return;
    }

    warning.classList.add('hidden');
    startBtn?.removeAttribute('disabled');
    startBtn?.removeAttribute('title');
}

export async function loadLabInfo(id) {
    setLabLoading(true);

    const progress = document.getElementById('progress-container');
    const status = document.getElementById('status');
    if (progress) progress.style.display = 'none';
    if (status) status.innerText = '';

    const errorEl = document.getElementById('lab-info-error');
    errorEl?.classList.add('hidden');

    try {
        const res = await apiFetch(`/api/lab/${id}`);
        const data = await res.json();

        if (!res.ok || data.error) {
            showLabIntro();
            updateLabBrowserWarning(false);
            document.getElementById('lab-title').innerText = 'Lab';
            if (errorEl) {
                errorEl.textContent = data.error || 'Lab not found.';
                errorEl.classList.remove('hidden');
            }
            document.getElementById('btn-start-lab')?.classList.add('hidden');
            return;
        }

        document.getElementById('lab-title').innerText = data.title || 'Lab';

        state.labTimeLimitSeconds = data.time_limit_minutes > 0 ? data.time_limit_minutes * 60 : 0;
        setLabStats(data);
        document.getElementById('btn-start-lab')?.classList.remove('hidden');

        const startBtn = document.getElementById('btn-start-lab');
        startBtn.onclick = () => startLabSession(id);
        updateLabBrowserWarning(data.live_streaming === true);

        if (data.session_active) {
            clearBootstrapCache();
            showLabActive(id, data);
            return;
        }

        showLabIntro();
    } catch (err) {
        showLabIntro();
        updateLabBrowserWarning(false);
        document.getElementById('lab-title').innerText = 'Lab';
        if (errorEl) {
            errorEl.textContent = isNetworkError(err) ? NETWORK_ERROR_MESSAGE : 'Failed to load lab.';
            errorEl.classList.remove('hidden');
        }
        document.getElementById('btn-start-lab')?.classList.add('hidden');
    } finally {
        setLabLoading(false);
    }
}

export async function startLabSession(id) {
    ensureNotificationPermission();

    try {
        const res = await securePost(`/api/lab/${id}/start`, {});
        const data = await res.json();

        if (data.error) {
            await showAlert(data.error, { title: 'Error' });
            loadLabInfo(id);
            return;
        }

        clearBootstrapCache();
        showLabActive(id, data);
    } catch (err) {
        if (!(await showNetworkError(err))) throw err;
    }
}

export function showLabActive(id, data) {
    state.labMaxUploadMb = Number(data.max_upload_mb) || 0;
    configureLabUploadMode(data.live_streaming === true);

    document.getElementById('lab-start-screen')?.classList.add('hidden');
    document.getElementById('lab-active-screen')?.classList.remove('hidden');
    document.getElementById('report')?.classList.add('hidden');

    const progress = document.getElementById('progress-container');
    const status = document.getElementById('status');
    if (progress) progress.style.display = 'none';
    if (status) status.innerText = '';

    const challenge = state.availableChallenges.find(c => c.id === id);
    document.getElementById('lab-active-title').innerText = challenge ? challenge.title : id;

    const dlArea = document.getElementById('lab-download-area');
    if (data.has_pka_file) {
        dlArea?.classList.remove('hidden');
        const dlBtn = document.getElementById('lab-download-btn');
        if (dlBtn) {
            dlBtn.href = `/api/lab/${id}/download`;
            dlBtn.setAttribute('download', '');
        }
    } else {
        dlArea?.classList.add('hidden');
    }

    if (data.time_remaining_seconds !== null && data.time_remaining_seconds !== undefined) {
        state.labWarnOnTick = createLabWarnScheduler(state.labTimeLimitSeconds);
    } else {
        state.labWarnOnTick = null;
    }

    startLabTimer(data.time_remaining_seconds, async () => {
        await showAlert("Time's up! You can no longer submit for this lab session.", { title: 'Time Expired' });
        stopStreaming();

        const uploadArea = document.getElementById('upload-area-box');
        if (uploadArea) {
            uploadArea.style.pointerEvents = 'none';
            uploadArea.style.opacity = '0.4';
        }

        const streamArea = document.getElementById('stream-pick-area');
        if (streamArea) {
            streamArea.style.pointerEvents = 'none';
            streamArea.style.opacity = '0.4';
        }

        document.getElementById('btn-lab-submit')?.setAttribute('disabled', 'disabled');
    });
}
