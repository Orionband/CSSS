import { initShell } from './shell.js';
import { loadUserDetail } from './user-detail.js';

document.addEventListener('DOMContentLoaded', async () => {
    if (!await initShell('leaderboard')) return;

    const username = new URLSearchParams(location.search).get('u');
    if (!username) {
        location.href = '/leaderboard';
        return;
    }

    await loadUserDetail(username);
});
