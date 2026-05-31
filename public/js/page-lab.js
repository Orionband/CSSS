import { state } from './state.js';
import { initShell } from './shell.js';
import { loadLabInfo } from './lab.js';
import { initUploadHandlers } from './upload.js';

document.addEventListener('DOMContentLoaded', async () => {
    if (!await initShell('challenges', { connectSocket: true })) return;

    initUploadHandlers();

    const id = new URLSearchParams(location.search).get('id');
    if (!id) {
        location.href = '/challenges';
        return;
    }

    state.currentChallengeId = id;
    state.currentChallengeType = 'lab';

    document.getElementById('upload-area-box')?.addEventListener('click', () => {
        document.getElementById('f')?.click();
    });

    await loadLabInfo(id);
});
