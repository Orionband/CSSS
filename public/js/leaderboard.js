import { escapeHtml } from './utils.js';

function formatDuration(seconds) {
    if (seconds == null) return '—';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

export async function loadLeaderboard() {
    const res = await fetch('/api/leaderboard');
    const data = await res.json();
    if (data.error) {
        alert(data.error);
        return;
    }

    const theadRow = document.querySelector('#lb-table thead tr');
    theadRow.innerHTML = '<th>Rank</th><th>User</th>';
    data.labs.forEach(l => {
        const th = document.createElement('th');
        th.innerText = l.title;
        theadRow.appendChild(th);
    });
    const thTotal = document.createElement('th');
    thTotal.innerText = 'Total';
    theadRow.appendChild(thTotal);
    const thTime = document.createElement('th');
    thTime.innerText = 'Time';
    theadRow.appendChild(thTime);

    const tbody = document.getElementById('lb-body');
    tbody.innerHTML = '';

    if (data.truncated) {
        const note = document.createElement('tr');
        note.innerHTML = `<td colspan="${3 + data.labs.length}" class="text-dim-sm">Showing top ${data.leaderboard.length} of ${data.total_entries} ranked entries. Ties broken by fastest total time.</td>`;
        tbody.appendChild(note);
    }

    data.leaderboard.forEach((entry, index) => {
        const tr = document.createElement('tr');
        tr.className = 'lb-row-clickable';
        tr.title = `View ${entry.username} detail`;
        tr.addEventListener('click', () => {
            location.href = `/leaderboard/user?u=${encodeURIComponent(entry.username)}`;
        });
        let html = `<td>#${index + 1}</td><td>${escapeHtml(entry.username)}</td>`;
        data.labs.forEach(l => {
            const score = entry.scores[l.id] || 0;
            html += `<td class="text-dim">${escapeHtml(String(score))}</td>`;
        });
        html += `<td class="text-accent-bold">${escapeHtml(String(entry.total_score))}</td>`;
        html += `<td class="text-dim">${escapeHtml(formatDuration(entry.total_time_seconds))}</td>`;
        tr.innerHTML = html;
        tbody.appendChild(tr);
    });
}
