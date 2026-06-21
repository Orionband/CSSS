import { state } from './state.js';
import { applyBranding, NETWORK_ERROR_MESSAGE, escapeHtml } from './utils.js';
import { renderNav, setupNavUser } from './nav.js';
import { logout } from './auth.js';

const STATUS_LABELS = {
    upcoming: 'Upcoming',
    live: 'Live',
    ended: 'Ended',
};

function setVisible(el, visible) {
    if (!el) return;
    el.classList.toggle('hidden', !visible);
}

function renderTextBlock(sectionId, titleId, bodyId, block) {
    const section = document.getElementById(sectionId);
    const titleEl = document.getElementById(titleId);
    const bodyEl = document.getElementById(bodyId);
    if (!section || !titleEl || !bodyEl || !block?.body) {
        setVisible(section, false);
        return;
    }
    titleEl.textContent = block.title || '';
    bodyEl.textContent = block.body;
    setVisible(section, true);
}

function formatPeriodLabel(period) {
    if (period?.label) return period.label;
    const parts = [];
    if (period?.start) parts.push(period.start);
    if (period?.end) parts.push(period.end);
    return parts.join(' – ');
}

function renderPeriod(period) {
    const row = document.getElementById('home-period-row');
    const periodEl = document.getElementById('home-period');
    const statusEl = document.getElementById('home-period-status');
    if (!row || !periodEl || !statusEl) return;

    const label = formatPeriodLabel(period);
    if (!label && !period?.status) {
        setVisible(row, false);
        return;
    }

    periodEl.textContent = label;
    setVisible(row, true);

    if (period?.status && STATUS_LABELS[period.status]) {
        statusEl.textContent = STATUS_LABELS[period.status];
        statusEl.className = `home-period-badge home-period-badge--${period.status}`;
        setVisible(statusEl, true);
    } else {
        setVisible(statusEl, false);
    }
}

function renderLogo(logoPath) {
    const logoEl = document.getElementById('home-logo');
    if (!logoEl) return;
    logoEl.src = logoPath || '/logo.png';
    logoEl.onerror = () => {
        logoEl.classList.add('hidden');
    };
}

function setDocumentTitle(pageTitle, appTitle) {
    if (pageTitle && appTitle) {
        document.title = `${pageTitle} · ${appTitle}`;
    } else if (pageTitle) {
        document.title = pageTitle;
    } else if (appTitle) {
        document.title = appTitle;
    }
}

function hideHomeFailureBanner() {
    document.getElementById('home-failure-banner')?.remove();
}

function showHomeFailureBanner(onRetry) {
    hideHomeFailureBanner();

    const host = document.querySelector('.home-page') || document.body;
    const banner = document.createElement('div');
    banner.id = 'home-failure-banner';
    banner.className = 'bootstrap-failure-banner';
    banner.innerHTML = `
        <p>${escapeHtml(NETWORK_ERROR_MESSAGE)}</p>
        <button type="button" class="btn-secondary btn-small" id="home-retry-btn">Retry</button>
    `;
    host.prepend(banner);
    document.getElementById('home-retry-btn')?.addEventListener('click', onRetry);
}

function applySessionNav(data) {
    const user = data.user?.unique_id ? data.user : null;
    if (user) {
        window.isAdmin = !!user.is_admin;
        window.isOwner = !!user.is_owner;
        state.availableChallenges = data.challenges || [];
    } else {
        window.isAdmin = false;
        window.isOwner = false;
        state.availableChallenges = [];
    }

    applyBranding(data.options || {});
    setupNavUser(user);
    renderNav(data.options || {}, 'home');
}

async function initHomePage() {
    hideHomeFailureBanner();

    let cfgRes;
    let meRes;
    try {
        [cfgRes, meRes] = await Promise.all([
            fetch('/api/config'),
            fetch('/api/me', { credentials: 'same-origin' }),
        ]);
    } catch {
        showHomeFailureBanner(() => initHomePage());
        return;
    }

    if (!cfgRes.ok) {
        showHomeFailureBanner(() => initHomePage());
        return;
    }

    let data;
    try {
        data = await cfgRes.json();
    } catch {
        showHomeFailureBanner(() => initHomePage());
        return;
    }

    if (!data.homepage) {
        location.replace('/');
        return;
    }

    const me = meRes.ok ? await meRes.json() : null;
    const user = me?.unique_id
        ? {
            username: me.username,
            unique_id: me.unique_id,
            is_admin: me.is_admin,
            is_owner: me.is_owner,
        }
        : null;

    applySessionNav({
        options: data.options || {},
        challenges: data.challenges || [],
        user,
    });

    document.getElementById('btn-logout')?.addEventListener('click', logout);

    const { homepage, options = {} } = data;
    setDocumentTitle(homepage.page_title, options.app_title);
    renderLogo(homepage.logo);

    const titleEl = document.getElementById('home-title');
    if (titleEl) {
        titleEl.textContent = homepage.page_title || '';
        setVisible(titleEl, Boolean(homepage.page_title));
    }

    const subtitleEl = document.getElementById('home-subtitle');
    if (subtitleEl) {
        subtitleEl.textContent = homepage.subtitle || '';
        setVisible(subtitleEl, Boolean(homepage.subtitle));
    }

    renderPeriod(homepage.period);
    renderTextBlock('home-readme', 'home-readme-title', 'home-readme-body', homepage.readme);
    renderTextBlock('home-rules', 'home-rules-title', 'home-rules-body', homepage.rules);
    renderTextBlock('home-prizes', 'home-prizes-title', 'home-prizes-body', homepage.prizes);
}

document.addEventListener('DOMContentLoaded', () => {
    initHomePage();
});
