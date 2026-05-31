import { state } from './state.js';
import { initShell } from './shell.js';
import { loadQuiz, submitQuiz, initQuizProtection } from './quiz.js';

document.addEventListener('DOMContentLoaded', async () => {
    if (!await initShell('challenges')) return;

    initQuizProtection();

    const id = new URLSearchParams(location.search).get('id');
    if (!id) {
        location.href = '/challenges.html';
        return;
    }

    state.currentChallengeId = id;
    state.currentChallengeType = 'quiz';

    document.getElementById('btn-submit-quiz')?.addEventListener('click', submitQuiz);

    await loadQuiz(id);
});
