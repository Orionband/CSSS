import { state } from './state.js';
import { renderLabResults, freezeLabTimer } from './lab.js';
import { clearBootstrapCache } from './auth.js';

let socketHandlersBound = false;

export function initUploadHandlers() {
    if (!socketHandlersBound) {
        state.socket.on('progress', (d) => {
            const progressBar = document.getElementById('progress-bar');
            const statusText = document.getElementById('status');
            if (!progressBar || !statusText) return;
            const pct = parseFloat(d.percent) || 0;
            progressBar.style.width = pct + '%';
            statusText.innerText = `${d.stage} (${Math.round(pct)}%)`;
        });

        state.socket.on('result', (data) => {
            const progressBar = document.getElementById('progress-bar');
            const statusText = document.getElementById('status');
            const checksList = document.getElementById('checks-list');
            const scoreBox = document.getElementById('final-score');
            if (!checksList) return;

            if (progressBar) progressBar.style.width = '100%';
            if (statusText) statusText.innerText = 'Done';
            checksList.innerHTML = '';
            document.getElementById('report')?.classList.remove('hidden');

            if (scoreBox) scoreBox.innerText = data.show_score ? `${data.total} / ${data.max}` : 'Hidden';

            if (data.clientBreakdown === null) {
                checksList.innerHTML = "<div class='challenges-empty'>Feedback hidden.</div>";
            } else {
                renderLabResults(checksList, data.clientBreakdown);
            }
            clearBootstrapCache();
        });

        state.socket.on('file_verified', () => {
            freezeLabTimer();
        });

        state.socket.on('err', (msg) => {
            const progressBar = document.getElementById('progress-bar');
            const statusText = document.getElementById('status');
            if (statusText) statusText.innerText = 'Error: ' + msg;
            if (progressBar) progressBar.style.background = '#f44747';
        });

        socketHandlersBound = true;
    }

    document.addEventListener('change', (e) => {
        if (e.target.id !== 'f') return;
        handleFileUpload(e.target);
    });
}

function handleFileUpload(fileInput) {
    const file = fileInput.files[0];
    if (!file || state.currentChallengeType !== 'lab') return;

    document.getElementById('report')?.classList.add('hidden');
    const progress = document.getElementById('progress-container');
    const progressBar = document.getElementById('progress-bar');
    const statusText = document.getElementById('status');
    if (progress) progress.style.display = 'block';
    if (progressBar) {
        progressBar.style.width = '0%';
        progressBar.style.background = 'var(--accent)';
    }
    if (statusText) statusText.innerText = 'Uploading...';
    fileInput.value = '';

    const reader = new FileReader();
    reader.onload = (evt) => {
        state.socket.emit('upload_file', {
            fileData: evt.target.result,
            labId: state.currentChallengeId,
            _csrf: state.csrfToken,
        });
        if (statusText) statusText.innerText = 'Queued...';
    };
    reader.readAsArrayBuffer(file);
}

