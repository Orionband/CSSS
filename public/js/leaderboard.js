import { escapeHtml } from './utils.js';

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

    const tbody = document.getElementById('lb-body');
    tbody.innerHTML = '';
    data.leaderboard.forEach((entry, index) => {
        const tr = document.createElement('tr');
        let html = `<td>#${index + 1}</td><td>${escapeHtml(entry.username)}</td>`;
        data.labs.forEach(l => {
            const score = entry.scores[l.id] || 0;
            html += `<td style="color:var(--text-dim)">${escapeHtml(String(score))}</td>`;
        });
        html += `<td style="color:var(--accent);font-weight:bold">${escapeHtml(String(entry.total_score))}</td>`;
        tr.innerHTML = html;
        tbody.appendChild(tr);
    });
}
