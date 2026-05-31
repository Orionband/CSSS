import { initShell } from './shell.js';
import { loadHistory, closeHistory } from './history.js';

document.addEventListener('DOMContentLoaded', async () => {
    if (!await initShell('history')) return;
    await loadHistory();

    document.getElementById('btn-close-history')?.addEventListener('click', closeHistory);
});
