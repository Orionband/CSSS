(function () {
    const CACHE_KEY = 'csss_auth_options';
    const MAX_RETRIES = 3;
    const RETRY_MS = 1000;
    let retryTimer = null;

    function cacheAuthOptions(options) {
        if (!options || typeof options !== 'object') return;
        try {
            sessionStorage.setItem(CACHE_KEY, JSON.stringify({
                discord_auth_enabled: Boolean(options.discord_auth_enabled),
            }));
        } catch { /* ignore */ }
    }

    function clearAuthCache() {
        try {
            sessionStorage.removeItem(CACHE_KEY);
        } catch { /* ignore */ }
    }

    function setLoadingState() {
        const view = document.getElementById('auth-view');
        if (!view) return;
        view.classList.add('auth-loading');
    }

    function applyAuthMode(discordOnly) {
        const view = document.getElementById('auth-view');
        const passwordForms = document.getElementById('password-auth-forms');
        const discordOnlyEl = document.getElementById('discord-auth-only');
        const discordHint = document.getElementById('discord-auth-hint');
        if (!view) return;

        view.classList.remove('auth-loading');
        view.classList.toggle('auth-mode-discord', discordOnly);
        view.classList.toggle('auth-mode-password', !discordOnly);
        if (passwordForms) passwordForms.classList.toggle('hidden', discordOnly);
        if (discordOnlyEl) discordOnlyEl.classList.toggle('hidden', !discordOnly);
        if (discordHint) {
            discordHint.textContent = discordOnly
                ? 'Use Discord to sign in or create an account.'
                : 'Use Discord to sign in.';
        }
    }

    function readCachedMode() {
        try {
            const raw = sessionStorage.getItem(CACHE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (typeof parsed.discord_auth_enabled !== 'boolean') return null;
            return parsed.discord_auth_enabled;
        } catch {
            return null;
        }
    }

    window.csssApplyAuthMode = applyAuthMode;
    window.csssCacheAuthOptions = cacheAuthOptions;

    async function loadAuthMode(retry = 0) {
        try {
            const res = await fetch('/api/config');
            if (!res.ok) throw new Error('config fetch failed');
            const data = await res.json();
            if (!data?.options) throw new Error('config missing options');

            const discordOnly = Boolean(data.options.discord_auth_enabled);
            const cached = readCachedMode();
            if (cached !== null && cached !== discordOnly) {
                clearAuthCache();
            }
            cacheAuthOptions(data.options);
            applyAuthMode(discordOnly);
        } catch {
            if (retry < MAX_RETRIES) {
                retryTimer = setTimeout(() => loadAuthMode(retry + 1), RETRY_MS);
            } else {
                setLoadingState();
            }
        }
    }

    const cached = readCachedMode();
    if (cached !== null) {
        applyAuthMode(cached);
    } else {
        setLoadingState();
    }

    loadAuthMode();
})();
