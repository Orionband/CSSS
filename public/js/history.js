import { escapeHtml, showAlert, apiFetch, NETWORK_ERROR_MESSAGE, isNetworkError } from './utils.js';
import { renderLabResults } from './lab.js';
import { consumePrefetch } from './prefetch.js';

const HISTORY_LIMIT = 50;
let historyOffset = 0;

function formatDuration(seconds) {
    if (seconds == null) return null;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function renderHistoryRow(sub, list) {
    const item = document.createElement('div');
    item.className = 'history-row';
    const date = new Date(sub.timestamp).toLocaleString();
    item.addEventListener('click', () => showHistoryDetail(sub));

    const title = sub.title || sub.lab_id;
    const scoreText = sub.score !== null ? `${sub.score} / ${sub.max_score}` : 'Hidden';
    const timeText = formatDuration(sub.duration_seconds);
    const typeLabel = sub.type === 'quiz'
        ? '<span class="hist-type type-quiz">Quiz</span>'
        : '<span class="hist-type type-lab">Lab</span>';

    item.innerHTML = `
        <div>
            <div class="text-white-bold">${typeLabel} ${escapeHtml(title)}</div>
            <div class="hist-date">${date}${timeText ? ` · ${timeText}` : ''}</div>
        </div>
        <div class="hist-score">${scoreText}</div>
    `;
    list.appendChild(item);
}

function updateHistoryLoadMore(panel, hasMore) {
    let btn = document.getElementById('history-load-more');
    if (!hasMore) {
        if (btn) btn.remove();
        return;
    }
    if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'history-load-more';
        btn.className = 'btn-secondary';
        btn.classList.add('mt-12');
        btn.textContent = 'Load more';
        btn.addEventListener('click', () => loadHistory(true));
        panel.appendChild(btn);
    }
}

export async function loadHistory(append = false) {
    if (!append) historyOffset = 0;

    const panel = document.getElementById('history-list-panel');
    const list = document.getElementById('history-list');

    try {
        let data = null;
        if (!append && historyOffset === 0) {
            data = consumePrefetch('history');
        }
        if (!data) {
            const res = await apiFetch(`/api/history?limit=${HISTORY_LIMIT}&offset=${historyOffset}`);
            if (res.status === 401) return;
            data = await res.json();
        }
        if (data.error) {
            await showAlert(data.error, { title: 'Error' });
            return;
        }

        if (!append && (!data.history || data.history.length === 0)) {
            list.innerHTML = "<div class='challenges-empty'>No submissions yet.</div>";
            updateHistoryLoadMore(panel, false);
            return;
        }

        if (!append) list.innerHTML = '';
        (data.history || []).forEach(sub => renderHistoryRow(sub, list));

        if (data.hasMore) {
            historyOffset = data.offset + data.history.length;
        }
        updateHistoryLoadMore(panel, data.hasMore);
    } catch (err) {
        if (!append) {
            const msg = isNetworkError(err) ? NETWORK_ERROR_MESSAGE : 'Failed to load history.';
            list.innerHTML = `<div class='challenges-empty error-center'>${escapeHtml(msg)}</div>`;
            updateHistoryLoadMore(panel, false);
        }
    }
}

function showHistoryDetail(sub) {
    document.getElementById('history-list-panel').classList.add('hidden');
    document.getElementById('history-detail').classList.remove('hidden');
    document.getElementById('hist-date').innerText = new Date(sub.timestamp).toLocaleString();

    document.getElementById('hist-lab').innerText = sub.title || sub.lab_id;
    const timeLabel = formatDuration(sub.duration_seconds);
    const scoreLine = sub.score !== null ? `${sub.score} / ${sub.max_score}` : 'Hidden';
    document.getElementById('hist-score').innerText = timeLabel ? `${scoreLine} (${timeLabel})` : scoreLine;

    const cont = document.getElementById('hist-checks');
    cont.innerHTML = '';

    if (sub.details === null) {
        cont.innerHTML = "<div class='text-center-muted'>Details hidden.</div>";
    } else if (sub.details.length === 0) {
        cont.innerHTML = "<div class='text-center-muted'>No awarded points to display.</div>";
    } else if (sub.type === 'quiz') {
        sub.details.forEach(item => {
            const row = document.createElement('div');
            row.className = `quiz-feedback ${item.correct ? 'correct' : 'missed'}`;
            row.innerHTML = `<strong>${escapeHtml(item.message)}</strong>: ${item.correct ? 'Correct' : 'Missed'}`;
            cont.appendChild(row);
        });
    } else {
        renderLabResults(cont, sub.details);
    }
}

export function closeHistory() {
    document.getElementById('history-detail').classList.add('hidden');
    document.getElementById('history-list-panel').classList.remove('hidden');
}
