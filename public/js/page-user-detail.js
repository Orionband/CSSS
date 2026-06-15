import { initShell } from './shell.js';
import { loadUserDetail } from './user-detail.js';

document.addEventListener('DOMContentLoaded', async () => {
    const username = new URLSearchParams(location.search).get('u');
    if (!username) {
        location.href = '/leaderboard';
        return;
    }

    if (!await initShell('leaderboard')) return;
    await loadUserDetail(username);
});
