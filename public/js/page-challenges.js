import { initShell } from './shell.js';
import { switchChallengeTab } from './challenges.js';

document.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('click', (e) => {
        const tabBtn = e.target.closest('[data-challenge-tab]');
        if (tabBtn) switchChallengeTab(tabBtn.dataset.challengeTab);
    });
    initShell('challenges');
});
