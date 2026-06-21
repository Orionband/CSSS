import { state } from './state.js';
import { prefetchRoute } from './prefetch.js';

const NAV_ITEMS = [
    { page: 'challenges', href: '/challenges', label: 'Challenges', visible: () => state.availableChallenges.length > 0 },
    { page: 'leaderboard', href: '/leaderboard', label: 'Leaderboard', visible: (o) => o.show_leaderboard },
    { page: 'history', href: '/history', label: 'History', visible: (o) => o.show_history },
    { page: 'admin', href: '/admin', label: 'Admin', visible: () => window.isAdmin, admin: true },
];

export function setNavBrandHref(options = {}) {
    const brand = document.getElementById('nav-brand');
    if (!brand) return;
    brand.href = options.homepage_enabled ? '/' : '/challenges';
}

export function setupNavUser(user) {
    const uidEl = document.getElementById('uid-display');
    const logoutBtn = document.getElementById('btn-logout');
    const loginLink = document.getElementById('nav-login');

    if (user?.unique_id) {
        if (uidEl) {
            const name = user.username ? `${user.username} · ` : '';
            uidEl.textContent = `${name}${user.unique_id}`;
            uidEl.classList.remove('hidden');
        }
        logoutBtn?.classList.remove('hidden');
        loginLink?.classList.add('hidden');
        return;
    }

    uidEl?.classList.add('hidden');
    logoutBtn?.classList.add('hidden');
    loginLink?.classList.remove('hidden');
}

export function renderNav(options, activePage) {
    state.appOptions = options;
    setNavBrandHref(options);
    const nav = document.getElementById('nav-links-container');
    if (!nav) return;
    nav.innerHTML = '';

    NAV_ITEMS.forEach(({ page, href, label, visible, admin }) => {
        if (!visible(options)) return;

        const link = document.createElement('a');
        link.href = href;
        link.className = 'nav-link navElement';
        if (admin) link.classList.add('nav-admin-link');
        if (page === activePage) link.classList.add('activeNav');
        link.textContent = label;
        link.addEventListener('mouseenter', () => prefetchRoute(href), { once: true });
        nav.appendChild(link);
    });
}
