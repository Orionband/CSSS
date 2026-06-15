import { state } from './state.js';

export const NETWORK_ERROR_MESSAGE = "Can't reach the server. Check your connection and try again.";

export class NetworkError extends Error {
    constructor(message = NETWORK_ERROR_MESSAGE) {
        super(message);
        this.name = 'NetworkError';
        this.network = true;
    }
}

export function isNetworkError(err) {
    return err instanceof NetworkError || err?.network === true;
}

/**
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number }} [options]
 */
export async function apiFetch(url, options = {}) {
    const { timeoutMs, ...fetchOptions } = options;
    const method = (fetchOptions.method || 'GET').toUpperCase();
    const defaultTimeout = method === 'GET' ? 15000 : 30000;
    const ms = timeoutMs ?? defaultTimeout;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);

    try {
        const res = await fetch(url, { ...fetchOptions, signal: controller.signal });
        return res;
    } catch (err) {
        if (err?.name === 'AbortError') {
            throw new NetworkError();
        }
        throw new NetworkError();
    } finally {
        clearTimeout(timer);
    }
}

export async function showNetworkError(err, { title = 'Error' } = {}) {
    if (!isNetworkError(err)) return false;
    await showAlert(NETWORK_ERROR_MESSAGE, { title });
    return true;
}

export function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export function parseDbTimestamp(dbTimestamp) {
    if (dbTimestamp == null) return NaN;
    const raw = String(dbTimestamp).trim();
    if (!raw) return NaN;
    if (raw.includes('T')) {
        const iso = /[zZ]|[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw}Z`;
        return new Date(iso).getTime();
    }
    return new Date(raw.replace(' ', 'T') + 'Z').getTime();
}

export async function fetchCsrfToken() {
    try {
        const res = await apiFetch('/api/csrf-token', { credentials: 'same-origin', timeoutMs: 15000 });
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
    return apiFetch(url, {
        method,
        headers,
        credentials: 'same-origin',
        body: JSON.stringify(body),
        timeoutMs: 30000,
    });
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

let dialogCleanup = null;
let dialogTail = Promise.resolve();
/** @type {((outcome: boolean | undefined) => void) | null} */
let activeDialogComplete = null;

function runQueuedDialog(setup) {
    return new Promise((resolveReturn) => {
        dialogTail = dialogTail.then(() => new Promise((advance) => {
            setup((outcome) => {
                resolveReturn(outcome);
                advance();
            });
        }));
    });
}

function dismissActiveDialog(outcome = undefined) {
    if (activeDialogComplete) {
        const complete = activeDialogComplete;
        activeDialogComplete = null;
        finishDialog();
        complete(outcome);
        return;
    }
    finishDialog();
}

function ensureModalHost() {
    let modal = document.getElementById('modal-container');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'modal-container';
    modal.className = 'modal hidden';
    modal.innerHTML = `
        <div class="modal-content" id="modal-box">
            <span class="modal-close" id="modal-close-btn">&times;</span>
            <div id="modal-inner"></div>
        </div>
    `;
    document.body.appendChild(modal);
    document.getElementById('modal-close-btn')?.addEventListener('click', closeModal);
    return modal;
}

/** Alerts/confirms use a separate layer so they never replace #modal-inner (and its listeners). */
function ensureDialogHost() {
    let dialog = document.getElementById('dialog-container');
    if (dialog) return dialog;

    dialog = document.createElement('div');
    dialog.id = 'dialog-container';
    dialog.className = 'modal hidden';
    dialog.innerHTML = `
        <div class="modal-content dialog" id="dialog-box">
            <div id="dialog-inner"></div>
        </div>
    `;
    document.body.appendChild(dialog);
    return dialog;
}

function formatDialogMessage(message) {
    const parts = String(message).split(/\n\n+/);
    if (parts.length <= 1) {
        return `<p class="dialog-message">${escapeHtml(message)}</p>`;
    }
    return parts.map(p => `<p class="dialog-message">${escapeHtml(p)}</p>`).join('');
}

function openDialog(contentHtml) {
    if (dialogCleanup) {
        dialogCleanup();
        dialogCleanup = null;
    }

    const dialog = ensureDialogHost();
    document.getElementById('dialog-inner').innerHTML = contentHtml;
    dialog.classList.remove('hidden');
    dialog.style.display = 'flex';
}

function finishDialog() {
    if (dialogCleanup) {
        dialogCleanup();
        dialogCleanup = null;
    }
    const dialog = document.getElementById('dialog-container');
    if (!dialog) return;
    dialog.classList.add('hidden');
    dialog.style.display = 'none';
}

function bindDialogEvents(onDismiss) {
    const dialog = ensureDialogHost();

    const onKeyDown = (e) => {
        if (e.key === 'Escape') onDismiss();
    };
    const onBackdrop = (e) => {
        if (e.target === dialog) onDismiss();
    };

    document.addEventListener('keydown', onKeyDown);
    dialog.addEventListener('click', onBackdrop);

    dialogCleanup = () => {
        document.removeEventListener('keydown', onKeyDown);
        dialog.removeEventListener('click', onBackdrop);
    };
}

export function showModal(contentHtml) {
    dismissActiveDialog(false);
    const modal = ensureModalHost();
    const closeBtn = document.getElementById('modal-close-btn');
    if (closeBtn) closeBtn.style.display = '';

    document.getElementById('modal-inner').innerHTML = contentHtml;
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
}

export function closeModal() {
    dismissActiveDialog(false);
    const modal = document.getElementById('modal-container');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.style.display = 'none';
}

export function showAlert(message, { title } = {}) {
    return runQueuedDialog((complete) => {
        const titleHtml = title ? `<h2 class="dialog-title text-accent">${escapeHtml(title)}</h2>` : '';
        openDialog(`
            ${titleHtml}
            ${formatDialogMessage(message)}
            <div class="dialog-actions">
                <button type="button" class="btn-secondary btn-small" id="dialog-ok-btn">OK</button>
            </div>
        `);

        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            activeDialogComplete = null;
            finishDialog();
            complete();
        };

        activeDialogComplete = finish;
        bindDialogEvents(finish);
        document.getElementById('dialog-ok-btn').addEventListener('click', finish);
    });
}

export function showConfirm(message, { title, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
    return runQueuedDialog((complete) => {
        const titleHtml = title ? `<h2 class="dialog-title text-accent">${escapeHtml(title)}</h2>` : '';
        const confirmClass = danger ? 'btn-danger' : 'btn-secondary';
        openDialog(`
            ${titleHtml}
            ${formatDialogMessage(message)}
            <div class="dialog-actions">
                <button type="button" class="btn-secondary btn-small" id="dialog-cancel-btn">${escapeHtml(cancelLabel)}</button>
                <button type="button" class="${confirmClass} btn-small" id="dialog-confirm-btn">${escapeHtml(confirmLabel)}</button>
            </div>
        `);

        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            activeDialogComplete = null;
            finishDialog();
            complete(result);
        };

        activeDialogComplete = () => finish(false);
        bindDialogEvents(() => finish(false));
        document.getElementById('dialog-cancel-btn').addEventListener('click', () => finish(false));
        document.getElementById('dialog-confirm-btn').addEventListener('click', () => finish(true));
    });
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
    state.labTimerExpired = false;
}
