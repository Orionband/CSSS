import { state } from './state.js';

import { escapeHtml } from './utils.js';



const CHALLENGE_LABELS = { lab: 'Lab', quiz: 'Quiz' };



export function switchChallengeTab(tab) {

    state.challengeTab = tab;



    document.querySelectorAll('[data-challenge-tab]').forEach(el => {

        el.classList.toggle('active', el.dataset.challengeTab === tab);

    });



    document.getElementById('challenges-labs')?.classList.toggle('hidden', tab !== 'labs');

    document.getElementById('challenges-quizzes')?.classList.toggle('hidden', tab !== 'quizzes');

}



function updateTabLabels(labs, quizzes) {

    document.querySelectorAll('[data-challenge-tab]').forEach(btn => {

        const tab = btn.dataset.challengeTab;

        const count = tab === 'labs' ? labs.length : quizzes.length;

        const name = tab === 'labs' ? 'Labs' : 'Quizzes';

        btn.textContent = count > 0 ? `${name} · ${count}` : name;

    });

}



function renderEmpty(container, kind) {

    const isLab = kind === 'lab';

    const other = isLab ? 'Quizzes' : 'Labs';

    const title = isLab ? 'No labs open right now' : 'No quizzes open right now';

    container.innerHTML = `

        <div class="challenges-empty">

            <p class="challenges-empty-title">${title}</p>

            <p class="challenges-empty-hint">Try the ${other} tab or check back later.</p>

        </div>

    `;

}



function renderGrid(container, challenges, kind) {

    if (!container) return;



    if (challenges.length === 0) {

        renderEmpty(container, kind);

        return;

    }



    const label = CHALLENGE_LABELS[kind];

    container.innerHTML = '';

    challenges.forEach(ch => {

        const page = ch.type === 'lab' ? '/lab' : '/quiz';

        const points = ch.points ?? 0;

        const card = document.createElement('a');

        card.href = `${page}?id=${encodeURIComponent(ch.id)}`;

        card.className = 'challenge-card';



        card.innerHTML = `

            <div class="challenge-card-body">

                <span class="challenge-badge">${label}</span>

                <h3 class="challenge-title">${escapeHtml(ch.title)}</h3>

            </div>

            <div class="challenge-card-aside">

                <span class="challenge-points-badge">${points} pt${points === 1 ? '' : 's'}</span>

                <span class="challenge-cta">Start<span class="challenge-cta-arrow" aria-hidden="true">→</span></span>

            </div>

        `;

        container.appendChild(card);

    });

}



export function renderChallengesList() {

    const labs = state.availableChallenges.filter(c => c.type === 'lab');

    const quizzes = state.availableChallenges.filter(c => c.type === 'quiz');



    updateTabLabels(labs, quizzes);

    renderGrid(document.getElementById('challenges-labs'), labs, 'lab');

    renderGrid(document.getElementById('challenges-quizzes'), quizzes, 'quiz');



    const tab = state.challengeTab || (labs.length > 0 ? 'labs' : 'quizzes');

    switchChallengeTab(tab);

}

