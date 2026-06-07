import { escapeHtml } from './utils.js';

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
