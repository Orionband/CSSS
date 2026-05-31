import { state } from './state.js';
import { securePost, fetchCsrfToken, applyBranding } from './utils.js';

export function toggleAuth(mode) {
    document.getElementById('login-form').classList.toggle('hidden', mode !== 'login');
    document.getElementById('register-form').classList.toggle('hidden', mode !== 'register');
    document.getElementById('auth-error').innerText = '';
}

export async function login() {
    const user = document.getElementById('l-user').value;
    const pass = document.getElementById('l-pass').value;
    const res = await securePost('/api/login', { username: user, password: pass });
    const data = await res.json();
    if (data.success) location.href = '/challenges.html';
    else document.getElementById('auth-error').innerText = data.error;
}

export async function register() {
    const user = document.getElementById('r-user').value;
    const email = document.getElementById('r-email').value;
    const pass = document.getElementById('r-pass').value;
    const res = await securePost('/api/register', { username: user, email, password: pass });
    const data = await res.json();
    if (data.success) location.href = '/challenges.html';
    else document.getElementById('auth-error').innerText = data.error;
}

export function clearBootstrapCache() {
    sessionStorage.removeItem('csss_bootstrap');
}

export async function logout() {
    await securePost('/api/logout');
    state.csrfToken = null;
    clearBootstrapCache();
    location.href = '/index.html';
}

export async function bootstrapAuthPage() {
    try {
        await fetchCsrfToken();
        const [meRes, cfgRes] = await Promise.all([fetch('/api/me'), fetch('/api/config')]);
        const meData = await meRes.json();
        const cfgData = await cfgRes.json();

        if (meData.unique_id) {
            location.href = '/challenges.html';
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
