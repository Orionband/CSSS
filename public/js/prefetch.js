const PREFETCH_PREFIX = 'csss_prefetch_';
const PREFETCH_TTL_MS = 30000;

const prefetchedHrefs = new Set();

const API_ROUTES = {
    '/leaderboard': { key: 'leaderboard', url: '/api/leaderboard' },
    '/history': { key: 'history', url: '/api/history?limit=50&offset=0' },
};

export function clearPrefetchCaches() {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const key = sessionStorage.key(i);
        if (key?.startsWith(PREFETCH_PREFIX)) {
            sessionStorage.removeItem(key);
        }
    }
    prefetchedHrefs.clear();
}

function readPrefetchEntry(key) {
    try {
        const raw = sessionStorage.getItem(PREFETCH_PREFIX + key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (Date.now() - parsed.cachedAt > PREFETCH_TTL_MS) {
            sessionStorage.removeItem(PREFETCH_PREFIX + key);
            return null;
        }
        return parsed.data;
    } catch {
        return null;
    }
}

export function consumePrefetch(key) {
    const data = readPrefetchEntry(key);
    if (data !== null) {
        sessionStorage.removeItem(PREFETCH_PREFIX + key);
    }
    return data;
}

function writePrefetch(key, data) {
    sessionStorage.setItem(PREFETCH_PREFIX + key, JSON.stringify({ cachedAt: Date.now(), data }));
}

async function prefetchApi(key, url) {
    if (readPrefetchEntry(key)) return;
    try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) return;
        const data = await res.json();
        if (!data.error) writePrefetch(key, data);
    } catch {
    }
}

export function prefetchRoute(href) {
    if (prefetchedHrefs.has(href)) return;
    prefetchedHrefs.add(href);

    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = href;
    document.head.appendChild(link);

    const route = API_ROUTES[href];
    if (route) prefetchApi(route.key, route.url);
}
