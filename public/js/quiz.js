import { state } from './state.js';
import { escapeHtml, securePost } from './utils.js';
import { clearBootstrapCache } from './auth.js';
import { playFinishSound, ensureNotificationPermission } from './sounds.js';

function setQuizLoading(loading) {
    document.getElementById('quiz-loading')?.classList.toggle('hidden', !loading);
    if (loading) {
        document.getElementById('quiz-start-screen')?.classList.add('hidden');
        document.getElementById('quiz-active-screen')?.classList.add('hidden');
        document.getElementById('quiz-result')?.classList.add('hidden');
    }
}

function setQuizStats(data) {
    document.getElementById('quiz-stat-time').textContent =
        data.time_limit > 0 ? `${data.time_limit} Minutes` : 'Unlimited';
    document.getElementById('quiz-stat-attempts').textContent =
        data.max_attempts > 0 ? `${data.attempts_taken} / ${data.max_attempts}` : `${data.attempts_taken} (Unlimited)`;
    document.getElementById('quiz-stat-questions').textContent = String(data.question_count);
}

function showQuizIntro() {
    document.getElementById('quiz-start-screen')?.classList.remove('hidden');
    document.getElementById('quiz-active-screen')?.classList.add('hidden');
    document.getElementById('quiz-result')?.classList.add('hidden');
}

function showQuizActive() {
    document.getElementById('quiz-start-screen')?.classList.add('hidden');
    document.getElementById('quiz-active-screen')?.classList.remove('hidden');
    document.getElementById('quiz-result')?.classList.add('hidden');
}

export async function loadQuiz(id) {
    setQuizLoading(true);

    const errorEl = document.getElementById('quiz-info-error');
    errorEl?.classList.add('hidden');

    const res = await fetch(`/api/quiz/${id}`);
    const data = await res.json();

    setQuizLoading(false);
    document.getElementById('quiz-title').innerText = data.title || 'Quiz';
    document.getElementById('quiz-active-title').innerText = data.title || 'Quiz';

    if (data.error) {
        showQuizIntro();
        if (errorEl) {
            errorEl.textContent = data.error;
            errorEl.classList.remove('hidden');
        }
        document.getElementById('btn-start-quiz')?.classList.add('hidden');
        return;
    }

    state.quizMetadataCache = data;
    setQuizStats(data);
    document.getElementById('quiz-timer').innerText = '';
    document.getElementById('btn-start-quiz')?.classList.remove('hidden');
    document.getElementById('btn-start-quiz').onclick = startQuizSession;

    if (data.session_active) {
        await startQuizSession();
        return;
    }

    showQuizIntro();
}

export async function startQuizSession() {
    if (!state.currentChallengeId) return;

    const res = await securePost(`/api/quiz/${state.currentChallengeId}/start`, {});
    const data = await res.json();

    if (data.error) {
        alert(data.error);
        loadQuiz(state.currentChallengeId);
        return;
    }

    clearBootstrapCache();
    showQuizActive();
    const area = document.getElementById('quiz-questions-area');
    area.innerHTML = '';
    document.getElementById('btn-submit-quiz').style.display = 'block';

    data.questions.forEach((q, idx) => {
        const card = document.createElement('div');
        card.className = 'quiz-question-card';
        card.dataset.type = q.type;
        card.innerHTML = `<div class="quiz-q-text">${idx + 1}. ${escapeHtml(q.text)}</div>`;

        if (q.image) {
            const img = document.createElement('img');
            img.src = `/api/quiz/asset/image/${q.image}`;
            img.style.maxWidth = '100%';
            card.appendChild(img);
        }

        if (q.pka) {
            const pkaLink = document.createElement('a');
            pkaLink.href = `/api/quiz/asset/pka/${q.pka}`;
            pkaLink.download = q.pka;
            pkaLink.className = 'lab-download-link inline-block-my';
            pkaLink.textContent = 'Download Packet Tracer Exhibit';
            card.appendChild(pkaLink);
        }

        const optsDiv = document.createElement('div');
        optsDiv.className = 'quiz-options';

        if (q.type === 'text') {
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.className = 'quiz-text-input';
            inp.name = `q_${idx}`;
            optsDiv.appendChild(inp);
        } else if (q.type === 'matching') {
            buildMatchingQuestion(optsDiv, q, idx);
        } else {
            q.answers.forEach(ans => {
                const label = document.createElement('label');
                const inp = document.createElement('input');
                inp.type = q.type;
                inp.name = `q_${idx}`;
                inp.value = ans.id;
                label.appendChild(inp);
                label.appendChild(document.createTextNode(ans.text));
                optsDiv.appendChild(label);
            });
        }

        card.appendChild(optsDiv);
        area.appendChild(card);
    });

    if (state.quizMetadataCache.time_limit > 0 && data.time_remaining_seconds !== undefined) {
        const targetEndTime = Date.now() + (data.time_remaining_seconds * 1000);
        const timerDiv = document.getElementById('quiz-timer');
        const updateTimer = () => {
            const remaining = Math.max(0, Math.floor((targetEndTime - Date.now()) / 1000));
            const m = Math.floor(remaining / 60);
            const s = remaining % 60;
            timerDiv.innerText = `${m}:${s < 10 ? '0' : ''}${s}`;
            if (remaining <= 0) {
                clearInterval(state.quizTimerInterval);
                state.quizTimerInterval = null;
                alert("Time's up! Submitting...");
                submitQuiz();
            }
        };
        updateTimer();
        state.quizTimerInterval = setInterval(updateTimer, 1000);
    }
}

function buildMatchingQuestion(optsDiv, q, idx) {
    const matchContainer = document.createElement('div');
    matchContainer.className = 'matching-container';

    const colLeft = document.createElement('div');
    colLeft.className = 'matching-col';
    q.leftItems.forEach(item => {
        const row = document.createElement('div');
        row.className = 'match-item';
        row.innerHTML = `<div class="match-left">${escapeHtml(item.text)}</div>`;

        const dropZone = document.createElement('div');
        dropZone.className = 'drop-zone';
        dropZone.dataset.leftId = item.id;
        dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); };
        dropZone.ondragleave = () => dropZone.classList.remove('drag-over');
        dropZone.ondrop = (e) => {
            e.preventDefault();
            dropZone.classList.remove('drag-over');
            const optId = e.dataTransfer.getData('text/plain');
            const draggedElement = document.getElementById(optId);
            if (draggedElement) {
                dropZone.innerHTML = '';
                dropZone.appendChild(draggedElement);
            }
        };
        row.appendChild(dropZone);
        colLeft.appendChild(row);
    });

    const colRight = document.createElement('div');
    colRight.className = 'matching-col';
    const pool = document.createElement('div');
    pool.className = 'drop-zone pool-zone';
    pool.style.minHeight = '100px';
    pool.ondragover = (e) => e.preventDefault();
    pool.ondrop = (e) => {
        e.preventDefault();
        const optId = e.dataTransfer.getData('text/plain');
        const draggedElement = document.getElementById(optId);
        if (draggedElement) pool.appendChild(draggedElement);
    };

    q.rightOptions.forEach(opt => {
        const dragItem = document.createElement('div');
        dragItem.className = 'draggable-item';
        dragItem.draggable = true;
        dragItem.id = `opt-${idx}-${opt.id}`;
        dragItem.dataset.val = opt.id;
        dragItem.innerText = opt.text;
        dragItem.ondragstart = (e) => e.dataTransfer.setData('text/plain', dragItem.id);
        pool.appendChild(dragItem);
    });
    colRight.appendChild(pool);

    matchContainer.appendChild(colLeft);
    matchContainer.appendChild(colRight);
    optsDiv.appendChild(matchContainer);
}

export async function submitQuiz() {
    ensureNotificationPermission();

    if (state.quizTimerInterval) {
        clearInterval(state.quizTimerInterval);
        state.quizTimerInterval = null;
    }

    const answers = {};
    const area = document.getElementById('quiz-questions-area');
    const cards = area.getElementsByClassName('quiz-question-card');

    for (let i = 0; i < cards.length; i++) {
        const type = cards[i].dataset.type;

        if (type === 'text') {
            const textInput = cards[i].querySelector('input[type="text"]');
            if (textInput) answers[i] = textInput.value;
        } else if (type === 'matching') {
            const matches = {};
            cards[i].querySelectorAll('.match-item').forEach(row => {
                const zone = row.querySelector('.drop-zone');
                const leftId = zone.dataset.leftId;
                const child = zone.querySelector('.draggable-item');
                if (child) matches[leftId] = child.dataset.val;
            });
            answers[i] = matches;
        } else {
            const inputs = cards[i].querySelectorAll('input:checked');
            if (inputs.length === 1 && type === 'radio') {
                answers[i] = inputs[0].value;
            } else if (inputs.length > 0) {
                answers[i] = Array.from(inputs).map(inp => inp.value);
            }
        }
    }

    const res = await securePost(`/api/quiz/${state.currentChallengeId}/submit`, { answers });
    const result = await res.json();

    if (result.error) {
        alert(result.error);
        return;
    }

    playFinishSound({
        title: 'Quiz submitted',
        body: 'Your quiz answers have been recorded.',
    });

    area.querySelectorAll('input').forEach(inp => { inp.disabled = true; });
    area.querySelectorAll('.draggable-item').forEach(d => {
        d.removeAttribute('draggable');
        d.ondragstart = null;
        d.style.cursor = 'not-allowed';
        d.style.opacity = '0.7';
    });
    area.querySelectorAll('.drop-zone').forEach(dz => {
        dz.ondrop = null;
        dz.ondragover = null;
        dz.ondragleave = null;
    });

    document.getElementById('btn-submit-quiz').style.display = 'none';
    document.getElementById('quiz-active-screen')?.classList.add('hidden');
    document.getElementById('quiz-result')?.classList.remove('hidden');

    if (result.score !== null) {
        document.getElementById('quiz-score-display').innerText = `Score: ${result.score} / ${result.max_score}`;
    } else {
        document.getElementById('quiz-score-display').innerText = 'Score Hidden';
    }

    const feedList = document.getElementById('quiz-feedback-list');
    feedList.innerHTML = '';

    if (result.breakdown) {
        if (result.breakdown.length === 0) {
            feedList.innerHTML = "<div class='challenges-empty'>No awarded points to display.</div>";
        } else {
            result.breakdown.forEach(item => {
                const div = document.createElement('div');
                div.className = `quiz-feedback ${item.correct ? 'correct' : 'missed'}`;
                div.innerHTML = `<strong>${escapeHtml(item.message)}</strong>: ${item.correct ? 'Correct' : 'Missed'}<br><small>Explanation: ${escapeHtml(item.explanation)}</small>`;
                feedList.appendChild(div);
            });
        }
    } else {
        feedList.innerHTML = '<em>Corrections hidden by instructor.</em>';
    }

    window.scrollTo(0, 0);
    clearBootstrapCache();
}

export function initQuizProtection() {
    ['copy', 'paste', 'cut', 'contextmenu'].forEach(evt => {
        document.addEventListener(evt, (e) => {
            if (e.target.closest('#quiz-active-screen')) e.preventDefault();
        });
    });
}
