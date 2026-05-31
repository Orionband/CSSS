import { initShell } from './shell.js';
import { loadLeaderboard } from './leaderboard.js';

document.addEventListener('DOMContentLoaded', async () => {
    if (!await initShell('leaderboard')) return;
    await loadLeaderboard();
});
