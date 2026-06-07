import { state } from './state.js';

import { securePost } from './utils.js';

import { clearBootstrapCache } from './auth.js';

import { createLabWarnScheduler, ensureNotificationPermission } from './sounds.js';

import { configureLabUploadMode, stopStreaming } from './upload.js';



export { renderLabResults } from './lab-results.js';

export { freezeLabTimer } from './lab-timer.js';



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



export async function loadLabInfo(id) {

    setLabLoading(true);



    const progress = document.getElementById('progress-container');

    const status = document.getElementById('status');

    if (progress) progress.style.display = 'none';

    if (status) status.innerText = '';



    const errorEl = document.getElementById('lab-info-error');

    errorEl?.classList.add('hidden');



    const res = await fetch(`/api/lab/${id}`);

    const data = await res.json();



    setLabLoading(false);



    if (!res.ok || data.error) {

        showLabIntro();

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



    if (data.session_active) {

        clearBootstrapCache();

        showLabActive(id, data);

        return;

    }



    showLabIntro();

}



export async function startLabSession(id) {

    ensureNotificationPermission();

    const res = await securePost(`/api/lab/${id}/start`, {});

    const data = await res.json();



    if (data.error) {

        alert(data.error);

        loadLabInfo(id);

        return;

    }



    clearBootstrapCache();

    showLabActive(id, data);

}



export function showLabActive(id, data) {

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



    const timerDiv = document.getElementById('lab-timer');

    if (state.labTimerInterval) clearInterval(state.labTimerInterval);

    state.labTimerFrozen = false;



    if (data.time_remaining_seconds !== null && data.time_remaining_seconds !== undefined) {

        const targetEndTime = Date.now() + (data.time_remaining_seconds * 1000);

        state.labWarnOnTick = createLabWarnScheduler(state.labTimeLimitSeconds);

        const updateTimer = () => {

            if (state.labTimerFrozen) return;

            const remaining = Math.max(0, Math.floor((targetEndTime - Date.now()) / 1000));

            const m = Math.floor(remaining / 60);

            const s = remaining % 60;

            timerDiv.innerText = `${m}:${s < 10 ? '0' : ''}${s}`;

            state.labWarnOnTick?.(remaining);



            if (remaining <= 0) {

                clearInterval(state.labTimerInterval);

                state.labTimerInterval = null;

                timerDiv.innerText = "TIME'S UP";

                timerDiv.style.color = '#f44747';

                alert("Time's up! You can no longer submit for this lab session.");

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

            }

        };

        updateTimer();

        state.labTimerInterval = setInterval(updateTimer, 1000);

    } else if (timerDiv) {

        timerDiv.innerText = '';

        state.labWarnOnTick = null;

    }

}


