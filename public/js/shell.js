import { state } from './state.js';
import { applyBranding, closeModal, fetchCsrfToken } from './utils.js';
import { renderNav } from './nav.js';
import { logout, clearBootstrapCache } from './auth.js';
import { renderChallengesList } from './challenges.js';

const BOOTSTRAP_CACHE_KEY = 'csss_bootstrap';
const BOOTSTRAP_TTL_MS = 120000;

function readBootstrapCache() {
    try {
        const raw = sessionStorage.getItem(BOOTSTRAP_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (Date.now() - parsed.cachedAt > BOOTSTRAP_TTL_MS) return null;
        return parsed.data;
    } catch {
        return null;
    }
}

export function writeBootstrapCache(data) {
    const { csrfToken: _csrf, ...cacheable } = data;
    sessionStorage.setItem(BOOTSTRAP_CACHE_KEY, JSON.stringify({ cachedAt: Date.now(), data: cacheable }));
}

function applyBootstrap(data, activePage) {
    if (data.csrfToken) state.csrfToken = data.csrfToken;

    window.isAdmin = !!data.user?.is_admin;
    window.isOwner = !!data.user?.is_owner;
    state.currentUser = data.user?.unique_id || null;

    const uidEl = document.getElementById('uid-display');
    if (uidEl && data.user?.unique_id) uidEl.innerText = data.user.unique_id;

    state.availableChallenges = data.challenges || [];
    if (data.options) applyBranding(data.options);
    renderNav(data.options || {}, activePage);

    if (activePage === 'challenges') renderChallengesList();
}

function connectSocket(uid) {
    if (!uid || typeof io === 'undefined') return;
    state.socket.disconnect();
    state.socket.connect();
    state.socket.once('connect', () => {
        state.socket.emit('authenticate', uid);
    });
}

async function fetchBootstrapFallback() {
    const [meRes, cfgRes] = await Promise.all([
        fetch('/api/me', { credentials: 'same-origin' }),
        fetch('/api/config', { credentials: 'same-origin' }),
    ]);
    if (meRes.status === 401) return { unauthorized: true };
    const meData = await meRes.json();
    const cfgData = await cfgRes.json();
    return {
        user: {
            id: meData.id,
            unique_id: meData.unique_id,
            is_admin: meData.is_admin,
            is_owner: meData.is_owner,
        },
        challenges: cfgData.challenges || [],
        options: cfgData.options || {},
    };
}

async function fetchBootstrapData() {
    const res = await fetch('/api/bootstrap', { credentials: 'same-origin' });
    if (res.ok) return res.json();
    if (res.status === 401) return { unauthorized: true };
    if (res.status === 404) return fetchBootstrapFallback();
    throw new Error(`Bootstrap failed (${res.status})`);
}

export async function initShell(activePage, { connectSocket: useSocket = false } = {}) {
    const cached = readBootstrapCache();
    if (cached) applyBootstrap(cached, activePage);

    let data = cached;
    try {
        data = await fetchBootstrapData();
        if (data.unauthorized) {
            clearBootstrapCache();
            location.href = '/';
            return false;
        }
        writeBootstrapCache(data);
        applyBootstrap(data, activePage);
    } catch {
        if (!data) return false;
    }

    await fetchCsrfToken();

    if (useSocket && data.user?.unique_id) connectSocket(data.user.unique_id);

    document.getElementById('btn-logout')?.addEventListener('click', logout);
    document.getElementById('modal-close-btn')?.addEventListener('click', closeModal);

    if (!window.__csssKeepAlive) {
        window.__csssKeepAlive = setInterval(() => fetch('/health').catch(() => {}), 20000);
    }

    return data;
}
