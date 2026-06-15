import { state } from './state.js';
import { securePost, fetchCsrfToken, applyBranding, NETWORK_ERROR_MESSAGE, isNetworkError, showAlert } from './utils.js';
import { clearPrefetchCaches } from './prefetch.js';

export function toggleAuth(mode) {
    document.getElementById('login-form').classList.toggle('hidden', mode !== 'login');
    document.getElementById('register-form').classList.toggle('hidden', mode !== 'register');
    document.getElementById('auth-error').innerText = '';
}

export async function login() {
    const user = document.getElementById('l-user').value;
    const pass = document.getElementById('l-pass').value;
    const errorEl = document.getElementById('auth-error');
    try {
        const res = await securePost('/api/login', { username: user, password: pass });
        const data = await res.json();
        if (data.success) {
            if (data.csrfToken) state.csrfToken = data.csrfToken;
            clearBootstrapCache();
            location.href = '/challenges';
        }
        else errorEl.innerText = data.error;
    } catch (err) {
        if (isNetworkError(err)) errorEl.innerText = NETWORK_ERROR_MESSAGE;
        else throw err;
    }
}

export async function register() {
    const user = document.getElementById('r-user').value;
    const email = document.getElementById('r-email').value;
    const pass = document.getElementById('r-pass').value;
    const errorEl = document.getElementById('auth-error');
    try {
        const res = await securePost('/api/register', { username: user, email, password: pass });
        const data = await res.json();
        if (data.success) {
            if (data.csrfToken) state.csrfToken = data.csrfToken;
            clearBootstrapCache();
            location.href = '/challenges';
        }
        else errorEl.innerText = data.error;
    } catch (err) {
        if (isNetworkError(err)) errorEl.innerText = NETWORK_ERROR_MESSAGE;
        else throw err;
    }
}

export function clearBootstrapCache() {
    sessionStorage.removeItem('csss_bootstrap');
    clearPrefetchCaches();
}

export async function logout() {
    try {
        await securePost('/api/logout');
    } catch (err) {
        if (isNetworkError(err)) {
            await showAlert(NETWORK_ERROR_MESSAGE, { title: 'Logout' });
        }
    }
    state.csrfToken = null;
    clearBootstrapCache();
    location.href = '/';
}

export async function bootstrapAuthPage() {
    try {
        await fetchCsrfToken();
        const [meRes, cfgRes] = await Promise.all([fetch('/api/me'), fetch('/api/config')]);
        const meData = await meRes.json();
        const cfgData = await cfgRes.json();

        if (meData.unique_id) {
            location.href = '/challenges';
            return;
        }

        if (cfgData.options) applyBranding(cfgData.options);
    } catch {
        try {
            const d = await fetch('/api/config').then(r => r.json());
            if (d.options) applyBranding(d.options);
        } catch { /* ignore */ }
    }
}
