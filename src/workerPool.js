const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_SCRIPT = path.join(__dirname, 'worker', 'worker.js');

class GraderWorkerPool {
    constructor(poolSize, workerTimeoutMs) {
        this.poolSize = poolSize;
        this.workerTimeoutMs = workerTimeoutMs;
        this.slots = [];
        this.waitingTasks = [];
        this.jobs = new Map();
        this.jobCounter = 0;
        this._initPool();
    }

    _initPool() {
        for (let i = 0; i < this.poolSize; i++) {
            this._addSlot();
        }
    }

    _addSlot() {
        const slot = { worker: null, busy: false, currentJobId: null, timeoutHandle: null };
        slot.worker = new Worker(WORKER_SCRIPT, { workerData: { poolMode: true } });
        slot.worker.on('message', (msg) => this._onWorkerMessage(slot, msg));
        slot.worker.on('error', () => this._handleWorkerFailure(slot, 'error'));
        slot.worker.on('exit', (code) => {
            if (code !== 0 && slot.busy) {
                this._failJob(slot, 'An internal processing error occurred.');
            }
            if (!this.slots.includes(slot)) return;
            this._replaceSlot(slot);
        });
        this.slots.push(slot);
        this._tryAssign(slot);
    }

    _replaceSlot(slot) {
        if (slot.timeoutHandle) clearTimeout(slot.timeoutHandle);
        const idx = this.slots.indexOf(slot);
        if (idx !== -1) this.slots.splice(idx, 1);
        try {
            slot.worker.terminate();
        } catch (e) { /* ignore */ }
        this._addSlot();
    }

    _handleWorkerFailure(slot, reason) {
        if (slot.busy) {
            this._failJob(slot, reason === 'error'
                ? 'An internal processing error occurred.'
                : 'Processing timed out.');
        }
        this._replaceSlot(slot);
    }

    _failJob(slot, message) {
        const jobId = slot.currentJobId;
        if (!jobId) return;
        const job = this.jobs.get(jobId);
        if (!job) return;
        if (slot.timeoutHandle) {
            clearTimeout(slot.timeoutHandle);
            slot.timeoutHandle = null;
        }
        slot.busy = false;
        slot.currentJobId = null;
        this.jobs.delete(jobId);
        job.onError(message);
        this._tryAssign(slot);
    }

    _onWorkerMessage(slot, msg) {
        const jobId = msg.jobId;
        if (!jobId) return;
        const job = this.jobs.get(jobId);
        if (!job) return;

        if (msg.type === 'progress' || msg.type === 'file_verified') {
            job.onMessage(msg);
            return;
        }

        if (msg.type === 'result' || msg.type === 'error') {
            if (slot.timeoutHandle) {
                clearTimeout(slot.timeoutHandle);
                slot.timeoutHandle = null;
            }
            slot.busy = false;
            slot.currentJobId = null;
            this.jobs.delete(jobId);
            job.onMessage(msg);
            this._tryAssign(slot);
        }
    }

    _tryAssign(slot) {
        if (slot.busy || this.waitingTasks.length === 0) return;

        const task = this.waitingTasks.shift();
        const jobId = ++this.jobCounter;

        slot.busy = true;
        slot.currentJobId = jobId;

        const job = {
            onMessage: task.onMessage,
            onError: task.onError,
        };
        this.jobs.set(jobId, job);

        const payload = { type: 'grade', jobId, ...task.workerPayload };
        const transferList = task.transferList || [];

        slot.timeoutHandle = setTimeout(() => {
            try {
                slot.worker.terminate();
            } catch (e) { /* ignore */ }
            this._handleWorkerFailure(slot, 'timeout');
        }, this.workerTimeoutMs);

        slot.worker.postMessage(payload, transferList);
    }

    getPendingCount() {
        return this.waitingTasks.length + this.jobs.size;
    }

    enqueue(workerPayload, transferList, onMessage, onError) {
        const task = { workerPayload, transferList, onMessage, onError };
        this.waitingTasks.push(task);

        for (const slot of this.slots) {
            if (!slot.busy) {
                this._tryAssign(slot);
            }
        }
    }

    shutdown() {
        for (const slot of this.slots) {
            if (slot.timeoutHandle) clearTimeout(slot.timeoutHandle);
            try {
                slot.worker.terminate();
            } catch (e) { /* ignore */ }
        }
        this.slots = [];
        this.waitingTasks = [];
        this.jobs.clear();
    }
}

module.exports = { GraderWorkerPool };
