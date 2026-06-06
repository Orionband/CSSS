const MAX_AUTH_ATTEMPTS_PER_SOCKET = 10;
const AUTH_ATTEMPTS_PER_IP_MAX = 30;
const AUTH_ATTEMPTS_PER_IP_WINDOW_MS = 60 * 1000;
const MAX_CONNECTIONS_PER_IP = 20;
const MAX_CONNECTIONS_PER_USER = 10;
const UPLOAD_ATTEMPTS_PER_USER_MAX = 8;
const UPLOAD_ATTEMPTS_WINDOW_MS = 60 * 1000;

function getSocketClientIp(socket) {
    const ip = socket.request?.ip;
    if (ip) return ip;
    return socket.handshake?.address || 'unknown';
}

function createWindowLimiter(windowMs, max) {
    const buckets = new Map();
    const timer = setInterval(() => {
        const now = Date.now();
        for (const [key, bucket] of buckets) {
            if (now - bucket.start >= windowMs) buckets.delete(key);
        }
    }, windowMs);
    if (typeof timer.unref === 'function') timer.unref();

    return function tryConsume(key) {
        const now = Date.now();
        let bucket = buckets.get(key);
        if (!bucket || now - bucket.start >= windowMs) {
            bucket = { start: now, count: 0 };
            buckets.set(key, bucket);
        }
        if (bucket.count >= max) return false;
        bucket.count++;
        return true;
    };
}

const authAttemptsByIp = createWindowLimiter(AUTH_ATTEMPTS_PER_IP_WINDOW_MS, AUTH_ATTEMPTS_PER_IP_MAX);
const uploadAttemptsByUser = createWindowLimiter(UPLOAD_ATTEMPTS_WINDOW_MS, UPLOAD_ATTEMPTS_PER_USER_MAX);
const connectionsByIp = new Map();

function registerSocketConnection(socket) {
    const ip = getSocketClientIp(socket);
    const count = (connectionsByIp.get(ip) || 0) + 1;
    if (count > MAX_CONNECTIONS_PER_IP) {
        return false;
    }
    connectionsByIp.set(ip, count);
    socket.once('disconnect', () => {
        const current = connectionsByIp.get(ip);
        if (!current || current <= 1) connectionsByIp.delete(ip);
        else connectionsByIp.set(ip, current - 1);
    });
    return true;
}

function canAddUserSocket(userId) {
    const set = global.activeUserSockets?.get(userId);
    return !set || set.size < MAX_CONNECTIONS_PER_USER;
}

module.exports = {
    MAX_AUTH_ATTEMPTS_PER_SOCKET,
    getSocketClientIp,
    authAttemptsByIp,
    uploadAttemptsByUser,
    registerSocketConnection,
    canAddUserSocket,
};
