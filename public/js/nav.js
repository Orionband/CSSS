import { state } from './state.js';

const NAV_ITEMS = [
    { page: 'challenges', href: '/challenges.html', label: 'Challenges', visible: () => state.availableChallenges.length > 0 },
    { page: 'leaderboard', href: '/leaderboard.html', label: 'Leaderboard', visible: (o) => o.show_leaderboard },
    { page: 'history', href: '/history.html', label: 'History', visible: (o) => o.show_history },
    { page: 'admin', href: '/admin.html', label: 'Admin', visible: () => window.isAdmin, admin: true },
];

export function renderNav(options, activePage) {
    state.appOptions = options;
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
        nav.appendChild(link);
    });
}
