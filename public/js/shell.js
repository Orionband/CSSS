import { state } from './state.js';
import { applyBranding, closeModal, fetchCsrfToken, apiFetch, NETWORK_ERROR_MESSAGE, escapeHtml } from './utils.js';
import { renderNav, setupNavUser } from './nav.js';
import { logout, clearBootstrapCache } from './auth.js';
import { renderChallengesList } from './challenges.js';

const BOOTSTRAP_CACHE_KEY = 'csss_bootstrap';
const BOOTSTRAP_TTL_MS = 120000;

let offlineListenersBound = false;
let bootstrapRetryHandler = null;

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

async function ensureCsrfToken() {
    if (state.csrfToken) return;
    await fetchCsrfToken();
}

export function writeBootstrapCache(data) {
    const { csrfToken: _csrf, ...cacheable } = data;
    sessionStorage.setItem(BOOTSTRAP_CACHE_KEY, JSON.stringify({ cachedAt: Date.now(), data: cacheable }));
}

function applyBootstrap(data, activePage) {
    if (data.csrfToken) state.csrfToken = data.csrfToken;

    window.isAdmin = !!data.user?.is_admin;
    window.isOwner = !!data.user?.is_owner;
    window.currentUserId = data.user?.id ?? null;
    window.adminReauthMethod = data.user?.admin_reauth_method || 'password';
    window.adminDiscordReauthValid = Boolean(data.user?.admin_discord_reauth_valid);
    state.currentUser = data.user?.unique_id || null;

    state.availableChallenges = data.challenges || [];
    if (data.options) applyBranding(data.options);
    setupNavUser(data.user);
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
        apiFetch('/api/me', { credentials: 'same-origin' }),
        apiFetch('/api/config', { credentials: 'same-origin' }),
    ]);
    if (meRes.status === 401) return { unauthorized: true };
    const meData = await meRes.json();
    const cfgData = await cfgRes.json();
    return {
        user: {
            id: meData.id,
            username: meData.username,
            unique_id: meData.unique_id,
            is_admin: meData.is_admin,
            is_owner: meData.is_owner,
            admin_reauth_method: meData.admin_reauth_method,
            admin_discord_reauth_valid: meData.admin_discord_reauth_valid,
        },
        challenges: cfgData.challenges || [],
        options: cfgData.options || {},
    };
}

async function fetchBootstrapData() {
    const res = await apiFetch('/api/bootstrap', { credentials: 'same-origin' });
    if (res.ok) return res.json();
    if (res.status === 401) return { unauthorized: true };
    if (res.status === 404) return fetchBootstrapFallback();
    throw new Error(`Bootstrap failed (${res.status})`);
}

function ensureOfflineBanner() {
    let banner = document.getElementById('network-offline-banner');
    if (banner) return banner;

    banner = document.createElement('div');
    banner.id = 'network-offline-banner';
    banner.className = 'network-offline-banner hidden';
    banner.setAttribute('role', 'status');
    banner.textContent = "You're offline. Some features may not work until you reconnect.";
    document.body.prepend(banner);
    return banner;
}

function updateOfflineBanner() {
    const banner = ensureOfflineBanner();
    banner.classList.toggle('hidden', navigator.onLine);
}

function bindOfflineListeners() {
    if (offlineListenersBound) return;
    offlineListenersBound = true;
    updateOfflineBanner();
    window.addEventListener('online', updateOfflineBanner);
    window.addEventListener('offline', updateOfflineBanner);
}

function hideBootstrapFailureBanner() {
    document.getElementById('bootstrap-failure-banner')?.remove();
}

function showBootstrapFailureBanner(onRetry) {
    hideBootstrapFailureBanner();

    const host = document.getElementById('main-content') || document.body;
    const banner = document.createElement('div');
    banner.id = 'bootstrap-failure-banner';
    banner.className = 'bootstrap-failure-banner';
    banner.innerHTML = `
        <p>${escapeHtml(NETWORK_ERROR_MESSAGE)}</p>
        <button type="button" class="btn-secondary btn-small" id="bootstrap-retry-btn">Retry</button>
    `;
    host.prepend(banner);
    document.getElementById('bootstrap-retry-btn')?.addEventListener('click', onRetry);
}

async function unauthorizedRedirect() {
    try {
        const cfg = await fetch('/api/config').then((r) => r.json());
        location.href = cfg.options?.homepage_enabled ? '/login' : '/';
    } catch {
        location.href = '/';
    }
}

async function loadBootstrap(activePage) {
    let data = readBootstrapCache();
    if (data) applyBootstrap(data, activePage);

    try {
        data = await fetchBootstrapData();
        if (data.unauthorized) {
            clearBootstrapCache();
            await unauthorizedRedirect();
            return { ok: false, unauthorized: true };
        }
        writeBootstrapCache(data);
        applyBootstrap(data, activePage);
        hideBootstrapFailureBanner();
        return { ok: true, data };
    } catch {
        if (!data) return { ok: false, data: null };
        return { ok: true, data, stale: true };
    }
}

export async function initShell(activePage, { connectSocket: useSocket = false } = {}) {
    bindOfflineListeners();

    const result = await loadBootstrap(activePage);
    if (result.unauthorized) return false;

    let data = result.data;
    if (!result.ok) {
        showBootstrapFailureBanner(async () => {
            if (bootstrapRetryHandler) return;
            bootstrapRetryHandler = true;
            try {
                const retry = await loadBootstrap(activePage);
                if (retry.ok && retry.data) {
                    data = retry.data;
                    await ensureCsrfToken();
                    if (useSocket && data.user?.unique_id) connectSocket(data.user.unique_id);
                }
            } finally {
                bootstrapRetryHandler = false;
            }
        });
        return false;
    }

    await ensureCsrfToken();

    if (useSocket && data?.user?.unique_id) connectSocket(data.user.unique_id);

    document.getElementById('btn-logout')?.addEventListener('click', logout);
    document.getElementById('modal-close-btn')?.addEventListener('click', closeModal);

    if (!window.__csssKeepAlive) {
        window.__csssKeepAlive = setInterval(() => fetch('/health').catch(() => {}), 20000);
    }

    return data;
}
