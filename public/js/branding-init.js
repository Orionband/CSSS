(function () {
    const CACHE_KEY = 'csss_bootstrap';

    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function applyBranding(options) {
        if (!options || typeof options !== 'object') return;

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

    window.csssApplyBranding = applyBranding;

    try {
        const raw = sessionStorage.getItem(CACHE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.data && parsed.data.options) {
            applyBranding(parsed.data.options);
        }
    } catch {
        /* ignore cache parse errors */
    }
})();
