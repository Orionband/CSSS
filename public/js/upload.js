import { state } from './state.js';

import { renderLabResults, freezeLabTimer } from './lab.js';

import { clearBootstrapCache } from './auth.js';



let socketHandlersBound = false;



/** @type {{ fileData: ArrayBuffer, labId: string, fileSizeBytes: number } | null} */

let pendingUpload = null;



function resetPendingUpload() {

    pendingUpload = null;

}



function setStatus(message) {

    const statusText = document.getElementById('status');

    if (statusText) statusText.innerText = message;

}



function setProgressError() {

    const progressBar = document.getElementById('progress-bar');

    if (progressBar) progressBar.style.background = '#f44747';

}



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



            resetPendingUpload();



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



        state.socket.on('grade_slot_waiting', (data) => {

            const position = parseInt(data?.position, 10);

            if (position > 0) {

                setStatus(`Waiting for grader (position ${position})...`);

            } else {

                setStatus('Waiting for grader...');

            }

        });



        state.socket.on('grade_slot_ready', (data) => {

            if (!pendingUpload) {

                setStatus('Error: No file ready to upload.');

                setProgressError();

                return;

            }

            if (data?.labId !== pendingUpload.labId) {

                setStatus('Error: Lab mismatch. Please submit again.');

                setProgressError();

                resetPendingUpload();

                return;

            }

            if (!data?.slotToken) {

                setStatus('Error: Invalid grading slot. Please submit again.');

                setProgressError();

                resetPendingUpload();

                return;

            }



            setStatus('Uploading...');

            state.socket.emit('upload_file', {

                fileData: pendingUpload.fileData,

                labId: pendingUpload.labId,

                fileSizeBytes: pendingUpload.fileSizeBytes,

                slotToken: data.slotToken,

                _csrf: state.csrfToken,

            });

            setStatus('Queued...');

        });



        state.socket.on('grade_slot_expired', (data) => {

            resetPendingUpload();

            setStatus('Error: ' + (data?.message || 'Upload window expired. Please submit again.'));

            setProgressError();

        });



        state.socket.on('err', (msg) => {

            resetPendingUpload();

            setStatus('Error: ' + msg);

            setProgressError();

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



    if (pendingUpload) {

        state.socket.emit('cancel_grade_slot', {

            labId: pendingUpload.labId,

            _csrf: state.csrfToken,

        });

        resetPendingUpload();

    }



    document.getElementById('report')?.classList.add('hidden');

    const progress = document.getElementById('progress-container');

    const progressBar = document.getElementById('progress-bar');

    const statusText = document.getElementById('status');

    if (progress) progress.style.display = 'block';

    if (progressBar) {

        progressBar.style.width = '0%';

        progressBar.style.background = 'var(--accent)';

    }

    if (statusText) statusText.innerText = 'Preparing...';

    fileInput.value = '';



    const reader = new FileReader();

    reader.onload = (evt) => {

        const fileData = evt.target.result;

        const fileSizeBytes = file.byteLength;



        pendingUpload = {

            fileData,

            labId: state.currentChallengeId,

            fileSizeBytes,

        };



        setStatus('Waiting for grader...');

        state.socket.emit('request_grade_slot', {

            labId: state.currentChallengeId,

            fileSizeBytes,

            _csrf: state.csrfToken,

        });

    };

    reader.readAsArrayBuffer(file);

}

