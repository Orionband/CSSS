const crypto = require('crypto');

const SLOT_TOKEN_BYTES = 32;
const SLOT_TOKEN_RE = /^[a-f0-9]{64}$/;

/**
 * FIFO admission queue: clients reserve a grader slot (metadata only), then upload when ready.
 * Slot tokens are single-use, bound to socket + user + lab, and time-limited.
 */
class GradeAdmissionQueue {
    /**
     * @param {object} opts
     * @param {number} opts.maxWorkers
     * @param {number} opts.maxAdmissionDepth
     * @param {number} opts.slotTtlMs
     * @param {() => number} opts.getGraderPendingCount
     */
    constructor({ maxWorkers, maxAdmissionDepth, slotTtlMs, getGraderPendingCount }) {
        this.maxWorkers = maxWorkers;
        this.maxAdmissionDepth = maxAdmissionDepth;
        this.slotTtlMs = slotTtlMs;
        this.getGraderPendingCount = getGraderPendingCount;
        /** @type {Array<object>} */
        this.waiting = [];
        /** @type {Map<string, object>} */
        this.grantedSlots = new Map();
        /** @type {Set<string>} */
        this.userLabKeys = new Set();
        /** @type {Map<string, string>} socketId -> userLabKey */
        this.socketToUserLab = new Map();
    }

    _userLabKey(userId, labId) {
        return `${userId}:${labId}`;
    }

    _availableGrantSlots() {
        return this.maxWorkers - this.getGraderPendingCount() - this.grantedSlots.size;
    }

    _queuePosition(entry) {
        const idx = this.waiting.indexOf(entry);
        return idx === -1 ? 0 : idx + 1;
    }

    _revokeGrantedSlot(slotToken) {
        const slot = this.grantedSlots.get(slotToken);
        if (!slot) return;
        if (slot.timeoutHandle) clearTimeout(slot.timeoutHandle);
        this.grantedSlots.delete(slotToken);
        this.userLabKeys.delete(this._userLabKey(slot.userId, slot.labId));
        this.socketToUserLab.delete(slot.socketId);
    }

    _emitSlotExpired(socket) {
        if (socket?.connected) {
            socket.emit('grade_slot_expired', { message: 'Upload window expired. Please submit again.' });
        }
    }

    /**
     * @returns {{ ok: true, position: number } | { ok: false, error: string }}
     */
    enqueue({ socket, userId, labId, fileSizeBytes }) {
        const userLabKey = this._userLabKey(userId, labId);

        if (this.userLabKeys.has(userLabKey)) {
            return { ok: false, error: 'You are already queued for this lab.' };
        }
        if (this.waiting.length >= this.maxAdmissionDepth) {
            return { ok: false, error: 'Server is busy. Please try again in a moment.' };
        }

        const entry = {
            socketId: socket.id,
            socket,
            userId,
            labId,
            fileSizeBytes,
            enqueuedAt: Date.now(),
        };
        this.waiting.push(entry);
        this.userLabKeys.add(userLabKey);
        this.socketToUserLab.set(socket.id, userLabKey);

        const position = this._queuePosition(entry);
        this.tryGrantSlots();
        return { ok: true, position };
    }

    /**
     * @returns {boolean}
     */
    cancelWaiting(socketId, userId, labId) {
        const userLabKey = this._userLabKey(userId, labId);
        const idx = this.waiting.findIndex(
            (e) => e.socketId === socketId && e.userId === userId && e.labId === labId
        );
        if (idx === -1) return false;

        this.waiting.splice(idx, 1);
        this.userLabKeys.delete(userLabKey);
        if (this.socketToUserLab.get(socketId) === userLabKey) {
            this.socketToUserLab.delete(socketId);
        }
        this.tryGrantSlots();
        return true;
    }

    removeSocket(socketId) {
        const userLabKey = this.socketToUserLab.get(socketId);
        if (userLabKey) {
            this.waiting = this.waiting.filter((e) => e.socketId !== socketId);
            this.userLabKeys.delete(userLabKey);
            this.socketToUserLab.delete(socketId);
        }

        for (const [token, slot] of this.grantedSlots) {
            if (slot.socketId === socketId) {
                this._revokeGrantedSlot(token);
            }
        }

        this.tryGrantSlots();
    }

    tryGrantSlots() {
        while (this._availableGrantSlots() > 0 && this.waiting.length > 0) {
            const entry = this.waiting.shift();
            const userLabKey = this._userLabKey(entry.userId, entry.labId);

            if (!entry.socket?.connected) {
                this.userLabKeys.delete(userLabKey);
                if (this.socketToUserLab.get(entry.socketId) === userLabKey) {
                    this.socketToUserLab.delete(entry.socketId);
                }
                continue;
            }

            const slotToken = crypto.randomBytes(SLOT_TOKEN_BYTES).toString('hex');
            const expiresAt = Date.now() + this.slotTtlMs;
            const timeoutHandle = setTimeout(() => {
                const slot = this.grantedSlots.get(slotToken);
                if (!slot) return;
                this._revokeGrantedSlot(slotToken);
                this._emitSlotExpired(slot.socket);
                this.tryGrantSlots();
            }, this.slotTtlMs);
            if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();

            this.grantedSlots.set(slotToken, {
                socketId: entry.socketId,
                socket: entry.socket,
                userId: entry.userId,
                labId: entry.labId,
                fileSizeBytes: entry.fileSizeBytes,
                expiresAt,
                timeoutHandle,
            });

            entry.socket.emit('grade_slot_ready', {
                slotToken,
                labId: entry.labId,
                expiresInMs: this.slotTtlMs,
            });
        }

        for (let i = 0; i < this.waiting.length; i++) {
            const entry = this.waiting[i];
            if (entry.socket?.connected) {
                entry.socket.emit('grade_slot_waiting', { position: i + 1 });
            }
        }
    }

    /**
     * @returns {{ ok: true } | { ok: false, error: string }}
     */
    consumeSlot(slotToken, { socketId, userId, labId, fileSizeBytes }) {
        if (typeof slotToken !== 'string' || !SLOT_TOKEN_RE.test(slotToken)) {
            return { ok: false, error: 'Invalid grading slot.' };
        }

        const slot = this.grantedSlots.get(slotToken);
        if (!slot) {
            return { ok: false, error: 'Invalid or expired grading slot. Please submit again.' };
        }

        if (slot.socketId !== socketId || slot.userId !== userId || slot.labId !== labId) {
            return { ok: false, error: 'Invalid grading slot.' };
        }
        if (Date.now() > slot.expiresAt) {
            this._revokeGrantedSlot(slotToken);
            this.tryGrantSlots();
            return { ok: false, error: 'Grading slot expired. Please submit again.' };
        }
        if (slot.fileSizeBytes !== fileSizeBytes) {
            return { ok: false, error: 'File size does not match your reservation.' };
        }

        if (slot.timeoutHandle) clearTimeout(slot.timeoutHandle);
        this.grantedSlots.delete(slotToken);
        this.userLabKeys.delete(this._userLabKey(userId, labId));
        this.socketToUserLab.delete(socketId);

        return { ok: true };
    }
}

module.exports = { GradeAdmissionQueue, SLOT_TOKEN_RE };
