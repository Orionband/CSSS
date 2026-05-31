import { state } from './state.js';
import { escapeHtml } from './utils.js';
import { renderLabResults } from './lab.js';

export async function loadHistory() {
    const res = await fetch('/api/history');
    const data = await res.json();

    if (data.error) {
        alert(data.error);
        return;
    }

    const list = document.getElementById('history-list');
    if (!data.history || data.history.length === 0) {
        list.innerHTML = "<div class='challenges-empty'>No submissions yet.</div>";
        return;
    }

    list.innerHTML = '';
    data.history.forEach(sub => {
        const item = document.createElement('div');
        item.className = 'history-row';
        const date = new Date(sub.timestamp).toLocaleString();
        item.addEventListener('click', () => showHistoryDetail(sub));

        const challenge = state.availableChallenges.find(c => c.id === sub.lab_id);
        const title = challenge ? challenge.title : sub.lab_id;
        const scoreText = sub.score !== null ? `${sub.score} / ${sub.max_score}` : 'Hidden';
        const typeLabel = sub.type === 'quiz'
            ? '<span class="hist-type type-quiz">Quiz</span>'
            : '<span class="hist-type type-lab">Lab</span>';

        item.innerHTML = `
            <div>
                <div style="font-weight:bold;color:#fff">${typeLabel} ${escapeHtml(title)}</div>
                <div class="hist-date">${date}</div>
            </div>
            <div class="hist-score">${scoreText}</div>
        `;
        list.appendChild(item);
    });
}

function showHistoryDetail(sub) {
    document.getElementById('history-list-panel').classList.add('hidden');
    document.getElementById('history-detail').classList.remove('hidden');
    document.getElementById('hist-date').innerText = new Date(sub.timestamp).toLocaleString();

    const challenge = state.availableChallenges.find(c => c.id === sub.lab_id);
    document.getElementById('hist-lab').innerText = challenge ? challenge.title : sub.lab_id;
    document.getElementById('hist-score').innerText = sub.score !== null ? `${sub.score} / ${sub.max_score}` : 'Hidden';

    const cont = document.getElementById('hist-checks');
    cont.innerHTML = '';

    if (sub.details === null) {
        cont.innerHTML = "<div style='text-align:center;color:#888'>Details hidden.</div>";
    } else if (sub.details.length === 0) {
        cont.innerHTML = "<div style='text-align:center;color:#888'>No awarded points to display.</div>";
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
