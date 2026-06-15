function startSocketSessionsSweeper(db, validateReloadedSession, intervalMs = 30 * 1000) {
    const handle = setInterval(() => {
        try {
            const map = global.activeUserSockets;
            if (!map?.size) return;
            for (const socketSet of map.values()) {
                for (const socket of socketSet) {
                    if (!socket.connected) continue;
                    const req = socket.request;
                    if (!req?.session) {
                        socket.disconnect(true);
                        continue;
                    }
                    req.session.reload((reloadErr) => {
                        if (reloadErr || !validateReloadedSession(db, req.session)) {
                            socket.disconnect(true);
                        }
                    });
                }
            }
        } catch (e) {
            console.error('Error in socket session sweep:', e.message);
        }
    }, intervalMs);

    if (typeof handle.unref === 'function') handle.unref();
    return handle;
}

module.exports = { startSocketSessionsSweeper };
