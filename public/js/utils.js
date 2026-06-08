import { state } from './state.js';

export function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export async function fetchCsrfToken() {
    try {
        const res = await fetch('/api/csrf-token', { credentials: 'same-origin' });
        const data = await res.json();
        if (data.csrfToken) state.csrfToken = data.csrfToken;
        else state.csrfToken = null;
    } catch {
        console.error('Failed to fetch CSRF token');
        state.csrfToken = null;
    }
}

export async function securePost(url, body = {}, method = 'POST') {
    if (!state.csrfToken) await fetchCsrfToken();
    const headers = { 'Content-Type': 'application/json' };
    if (state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
    return fetch(url, { method, headers, credentials: 'same-origin', body: JSON.stringify(body) });
}

export function applyBranding(options) {
    if (!options || typeof options !== 'object') return;
    if (typeof window.csssApplyBranding === 'function') {
        window.csssApplyBranding(options);
        return;
    }
    const main = options.app_title_main || '';
    const highlight = options.app_title_highlight || '';
    const full = options.app_title || '';
    if (!full && !main) return;

    const brandHtml = highlight
        ? `${escapeHtml(main)} <span>${escapeHtml(highlight)}</span>`
        : escapeHtml(full || main);

    const authTitle = document.getElementById('auth-title');
    if (authTitle) {
        if (highlight) authTitle.innerHTML = brandHtml;
        else authTitle.textContent = full || main;
        document.title = full || main;
        authTitle.classList.add('is-branded');
    }

    const navBrand = document.getElementById('nav-brand');
    if (navBrand) {
        if (highlight) navBrand.innerHTML = brandHtml;
        else navBrand.textContent = full || main;
        navBrand.classList.add('is-branded');
    }
}

export function showModal(contentHtml) {
    document.getElementById('modal-inner').innerHTML = contentHtml;
    const modal = document.getElementById('modal-container');
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
}

export function closeModal() {
    const modal = document.getElementById('modal-container');
    modal.classList.add('hidden');
    modal.style.display = 'none';
}

export function clearTimers() {
    if (state.quizTimerInterval) clearInterval(state.quizTimerInterval);
    if (state.labTimerInterval) clearInterval(state.labTimerInterval);
    state.quizTimerInterval = null;
    state.labTimerInterval = null;
    state.labTimerEndTime = null;
    state.labTimerFrozen = false;
    state.labTimerFrozenAt = null;
    state.labTimerOnExpire = null;
}
