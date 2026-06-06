import { state } from './state.js';
import { escapeHtml, securePost } from './utils.js';

export function freezeLabTimer() {
    if (state.labTimerInterval) {
        clearInterval(state.labTimerInterval);
        state.labTimerInterval = null;
    }
    state.labTimerFrozen = true;
}

export function renderLabResults(container, breakdown) {
    container.innerHTML = '';
    if (!breakdown || breakdown.length === 0) {
        container.innerHTML = "<div class='challenges-empty'>No awarded points to display.</div>";
        return;
    }

    const grouped = {};
    breakdown.forEach(item => {
        const dev = item.device || 'Unknown Device';
        const ctx = item.context || 'global';
        if (!grouped[dev]) grouped[dev] = {};
        if (!grouped[dev][ctx]) grouped[dev][ctx] = [];
        grouped[dev][ctx].push(item);
    });

    for (const dev of Object.keys(grouped).sort()) {
        const devDiv = document.createElement('div');
        devDiv.className = 'result-group';

        const devHeader = document.createElement('div');
        devHeader.className = 'result-group-header expanded';
        devHeader.innerHTML = `<span class="indicator">▶</span> ${escapeHtml(dev)}`;

        const devContent = document.createElement('div');
        devContent.className = 'result-group-content';

        devHeader.addEventListener('click', () => {
            devHeader.classList.toggle('expanded');
            devContent.classList.toggle('hidden');
        });

        for (const ctx of Object.keys(grouped[dev]).sort()) {
            const ctxDiv = document.createElement('div');
            ctxDiv.className = 'result-subgroup';

            const ctxHeader = document.createElement('div');
            ctxHeader.className = 'result-subgroup-header expanded';
            ctxHeader.innerHTML = `<span class="indicator">▶</span> ${escapeHtml(ctx)}`;

            const ctxContent = document.createElement('div');
            ctxContent.className = 'result-subgroup-content';

            ctxHeader.addEventListener('click', () => {
                ctxHeader.classList.toggle('expanded');
                ctxContent.classList.toggle('hidden');
            });

            grouped[dev][ctx].forEach(c => {
                const row = document.createElement('div');
                if (c.passed !== false) {
                    row.className = 'check-item ' + (c.points >= 0 ? 'gain' : 'penalty');
                    row.innerHTML = `<span>${escapeHtml(c.message)}</span><span class="pts">${c.points > 0 ? '+' + c.points : c.points}</span>`;
                } else {
                    row.className = 'check-item missed';
                    row.innerHTML = `<span>${escapeHtml(c.message)}</span><span class="pts text-pts">${c.points}</span>`;
                }
                ctxContent.appendChild(row);
            });

            ctxDiv.appendChild(ctxHeader);
            ctxDiv.appendChild(ctxContent);
            devContent.appendChild(ctxDiv);
        }

        devDiv.appendChild(devHeader);
        devDiv.appendChild(devContent);
        container.appendChild(devDiv);
    }
}

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

    setLabStats(data);
    document.getElementById('btn-start-lab')?.classList.remove('hidden');

    const startBtn = document.getElementById('btn-start-lab');
    startBtn.onclick = () => startLabSession(id);

    if (data.session_active) {
        showLabActive(id, data);
        return;
    }

    showLabIntro();
}

export async function startLabSession(id) {
    const res = await securePost(`/api/lab/${id}/start`, {});
    const data = await res.json();

    if (data.error) {
        alert(data.error);
        loadLabInfo(id);
        return;
    }

    showLabActive(id, data);
}

export function showLabActive(id, data) {
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
        const updateTimer = () => {
            const remaining = Math.max(0, Math.floor((targetEndTime - Date.now()) / 1000));
            const m = Math.floor(remaining / 60);
            const s = remaining % 60;
            timerDiv.innerText = `${m}:${s < 10 ? '0' : ''}${s}`;

            if (remaining <= 0) {
                clearInterval(state.labTimerInterval);
                state.labTimerInterval = null;
                timerDiv.innerText = "TIME'S UP";
                timerDiv.style.color = '#f44747';
                alert("Time's up! You can no longer submit for this lab session.");
                const uploadArea = document.getElementById('upload-area-box');
                if (uploadArea) {
                    uploadArea.style.pointerEvents = 'none';
                    uploadArea.style.opacity = '0.4';
                }
            }
        };
        updateTimer();
        state.labTimerInterval = setInterval(updateTimer, 1000);
    } else if (timerDiv) {
        timerDiv.innerText = '';
    }
}
