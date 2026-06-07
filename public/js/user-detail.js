import { escapeHtml } from './utils.js';

const CHART_COLORS = [
    '#f05d5e',
    '#4da6ff',
    '#4CAF50',
    '#d29922',
    '#bc8cff',
    '#56d4dd',
    '#ff9f43',
    '#a4de6c',
];

function formatDuration(seconds) {
    if (seconds == null) return '—';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function parseDbTimestamp(dbTimestamp) {
    return new Date(String(dbTimestamp).replace(' ', 'T') + 'Z').getTime();
}

function formatUtcDateTime(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

function formatUtcAxisTick(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function readCssVar(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}

function buildChartDatasets(challenges) {
    const datasets = [];
    let colorIndex = 0;

    for (const ch of challenges) {
        if (ch.hidden || ch.withheld || !ch.records?.length) continue;

        const color = CHART_COLORS[colorIndex % CHART_COLORS.length];
        colorIndex += 1;

        datasets.push({
            label: ch.title,
            data: ch.records.map(r => ({
                x: parseDbTimestamp(r.timestamp),
                y: r.score,
                duration_seconds: r.duration_seconds,
            })),
            borderColor: color,
            backgroundColor: color,
            fill: false,
            tension: 0.15,
            pointRadius: 4,
        });
    }

    return datasets;
}

function renderSummary(data) {
    const user = data.user;
    document.getElementById('detail-title').textContent = `${user.username} — Detail`;
    document.getElementById('detail-username').textContent = user.username;

    const scoreEl = document.getElementById('detail-total-score');
    if (user.withheld) {
        scoreEl.textContent = 'Withheld';
    } else {
        scoreEl.textContent = `Total: ${user.total_score}`;
    }

    document.getElementById('detail-total-time').textContent =
        user.withheld ? '' : `Time: ${formatDuration(user.total_time_seconds)}`;
}

function renderChallengeTable(challenges) {
    const tbody = document.getElementById('detail-table-body');
    tbody.innerHTML = '';

    for (const ch of challenges) {
        const tr = document.createElement('tr');
        let bestScore = '—';
        let bestTime = '—';
        let submissions = '—';

        if (ch.withheld) {
            bestScore = 'W';
            bestTime = 'W';
            submissions = 'W';
        } else if (ch.hidden) {
            bestScore = '?';
            bestTime = '?';
            submissions = '?';
        } else {
            bestScore = ch.best_score != null ? String(ch.best_score) : '—';
            bestTime = formatDuration(ch.best_duration_seconds);
            submissions = String(ch.records.length);
        }

        tr.innerHTML = `
            <td>${escapeHtml(ch.title)}</td>
            <td class="text-dim">${escapeHtml(bestScore)}</td>
            <td class="text-dim">${escapeHtml(bestTime)}</td>
            <td class="text-dim">${escapeHtml(submissions)}</td>
        `;
        tbody.appendChild(tr);
    }
}

function renderChart(challenges) {
    const canvas = document.getElementById('scores-chart');
    const emptyEl = document.getElementById('detail-chart-empty');
    const datasets = buildChartDatasets(challenges);

    if (!datasets.length || typeof Chart === 'undefined') {
        canvas?.classList.add('hidden');
        emptyEl?.classList.remove('hidden');
        return;
    }

    canvas?.classList.remove('hidden');
    emptyEl?.classList.add('hidden');

    const textColor = readCssVar('--text-dim', '#888');
    const gridColor = readCssVar('--input-bg', '#333');
    const accent = readCssVar('--accent', '#f05d5e');

    if (window.userDetailChart) {
        window.userDetailChart.destroy();
    }

    window.userDetailChart = new Chart(canvas, {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            parsing: false,
            scales: {
                x: {
                    type: 'linear',
                    title: {
                        display: true,
                        text: 'Time (UTC)',
                        color: textColor,
                    },
                    ticks: {
                        color: textColor,
                        maxRotation: 45,
                        callback(value) {
                            return formatUtcAxisTick(value);
                        },
                    },
                    grid: { color: gridColor },
                },
                y: {
                    title: {
                        display: true,
                        text: 'Points',
                        color: textColor,
                    },
                    ticks: { color: textColor, precision: 0 },
                    grid: { color: gridColor },
                    beginAtZero: true,
                },
            },
            plugins: {
                legend: {
                    labels: { color: textColor },
                },
                tooltip: {
                    callbacks: {
                        label(context) {
                            const timeLabel = formatUtcDateTime(context.parsed.x);
                            const dur = context.raw?.duration_seconds;
                            const durLabel = dur != null ? `, ${formatDuration(dur)} play time` : '';
                            return `${context.dataset.label}: ${context.parsed.y} pts @ ${timeLabel}${durLabel}`;
                        },
                    },
                },
            },
            elements: {
                line: { borderWidth: 2 },
            },
            color: accent,
        },
    });
}

export async function loadUserDetail(username) {
    const loading = document.getElementById('detail-loading');
    const errorEl = document.getElementById('detail-error');
    const content = document.getElementById('detail-content');

    loading?.classList.remove('hidden');
    errorEl?.classList.add('hidden');
    content?.classList.add('hidden');

    const res = await fetch(`/api/leaderboard/user/${encodeURIComponent(username)}`);
    const data = await res.json();

    loading?.classList.add('hidden');

    if (!res.ok || data.error) {
        if (errorEl) {
            errorEl.textContent = data.error || 'Failed to load player detail.';
            errorEl.classList.remove('hidden');
        }
        return;
    }

    renderSummary(data);
    renderChallengeTable(data.challenges);
    renderChart(data.challenges);
    content?.classList.remove('hidden');
}
