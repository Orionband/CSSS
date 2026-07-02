const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const { getConfig, isWindowOpen } = require('../config');
const { resolveUploadMb, maxUploadMbFromLabs } = require('../limits');
const { GraderWorkerPool } = require('../workerPool');
const { GradeAdmissionQueue } = require('../gradeAdmissionQueue');
const authRoutes = require('../routes/auth');
const quizRoutes = require('../routes/quiz');
const adminRoutes = require('../routes/admin');
const { securityHeadersMiddleware, apiCacheHeadersMiddleware } = require('./securityHeaders');
const {
    createSessionMiddleware,
    createSessionValidationMiddleware,
    createCsrfMiddleware,
    validateReloadedSession,
} = require('./session');
const { mountPages } = require('./pages');
const { createGradingDispatcher } = require('../grading/dispatch');
const { mountGradingSockets, streamGradeKey } = require('../sockets/gradingSocket');
const { startLabSessionsSweeper } = require('../sweepers/labSessions');
const { startSocketSessionsSweeper } = require('../sweepers/socketSessions');
const { startCapturesSweeper } = require('../sweepers/captures');
const { createLabSessionService } = require('../services/labSessionService');
const { requestIdMiddleware, generateRequestId, logInfo } = require('../logging');

const SHUTDOWN_DRAIN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS, 10) || 130000;
const SERVER_CLOSE_TIMEOUT_MS = parseInt(process.env.SERVER_CLOSE_TIMEOUT_MS, 10) || 30000;
const SOCKET_MAX_UPLOAD_MB = 50;

function createHealthHandler(db, graderPool) {
    return (req, res) => {
        const checks = { database: false, workerPool: false };
        try {
            db.prepare('SELECT 1').get();
            checks.database = true;
        } catch {
            checks.database = false;
        }

        try {
            graderPool.getPendingCount();
            checks.workerPool = graderPool.poolSize > 0;
        } catch {
            checks.workerPool = false;
        }

        const ok = checks.database && checks.workerPool;
        res.status(ok ? 200 : 503).json({
            status: ok ? 'ok' : 'degraded',
            checks,
        });
    };
}

function createApp(options = {}) {
    const db = options.db || require('../database');
    const sessionSecret = options.sessionSecret || process.env.SESSION_SECRET;
    const getConfigFn = options.getConfig || getConfig;
    const isWindowOpenFn = options.isWindowOpen || isWindowOpen;

    const app = express();
    app.disable('x-powered-by');

    const trustProxy = process.env.TRUST_PROXY?.trim();
    if (trustProxy) {
        const hops = Number(trustProxy);
        app.set('trust proxy', Number.isInteger(hops) && String(hops) === trustProxy ? hops : trustProxy);
    }

    const server = http.createServer(app);

    const cfgInitial = getConfigFn();
    const globalMaxUploadMB = maxUploadMbFromLabs(cfgInitial.labs);
    const socketMaxUploadMB = Math.min(
        globalMaxUploadMB,
        resolveUploadMb(process.env.DEFAULT_MAX_UPLOAD_MB, SOCKET_MAX_UPLOAD_MB),
        SOCKET_MAX_UPLOAD_MB
    );

    const io = new Server(server, {
        maxHttpBufferSize: socketMaxUploadMB * 1024 * 1024,
    });

    const MAX_WORKERS = parseInt(process.env.MAX_WORKERS, 10) || 4;
    const MAX_QUEUE_DEPTH = parseInt(process.env.MAX_QUEUE_DEPTH, 10) || 50;
    const WORKER_TIMEOUT_MS = 120000;
    const graderPool = options.graderPool || new GraderWorkerPool(MAX_WORKERS, WORKER_TIMEOUT_MS);
    const GRADE_SLOT_TTL_MS = parseInt(process.env.GRADE_SLOT_TTL_MS, 10) || 60000;
    const gradeAdmission = options.gradeAdmission || new GradeAdmissionQueue({
        maxWorkers: MAX_WORKERS,
        maxAdmissionDepth: MAX_QUEUE_DEPTH,
        slotTtlMs: GRADE_SLOT_TTL_MS,
        getGraderPendingCount: () => graderPool.getPendingCount(),
    });

    let isShuttingDown = false;
    const intervalHandles = [];

    function notifyGradingSlotsAvailable() {
        gradeAdmission.tryGrantSlots();
    }

    const cleanupTempFile = (filePath) => {
        if (filePath && fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
        }
    };

    const lastStreamGradeAt = new Map();
    const labSessionService = createLabSessionService(db);

    const { dispatchGradingTask } = createGradingDispatcher({
        db,
        graderPool,
        notifyGradingSlotsAvailable,
        lastStreamGradeAt,
        streamGradeKey,
        cleanupTempFile,
    });

    app.use(express.json({ limit: '1mb' }));
    app.use(requestIdMiddleware);
    app.use(securityHeadersMiddleware);
    app.use('/api', apiCacheHeadersMiddleware);

    app.get('/health', createHealthHandler(db, graderPool));

    const sessionMiddleware = createSessionMiddleware(db, sessionSecret, {
        disableStoreSweep: Boolean(options.testMode),
    });
    app.use(sessionMiddleware);
    io.engine.use(sessionMiddleware);

    app.use('/api', createSessionValidationMiddleware(db));
    app.use('/api', createCsrfMiddleware());

    app.use('/api', authRoutes);
    app.use('/api/quiz', quizRoutes);
    app.use('/api/admin', adminRoutes);

    const publicDir = options.publicDir || path.join(__dirname, '../../public');
    mountPages(app, db, publicDir, getConfigFn);

    if (!options.testMode) {
        intervalHandles.push(startLabSessionsSweeper(db, getConfigFn, isWindowOpenFn));
        intervalHandles.push(startSocketSessionsSweeper(db, validateReloadedSession));
        const capturesDir = path.join(__dirname, '../../captures');
        intervalHandles.push(startCapturesSweeper(capturesDir));
    }

    mountGradingSockets(io, {
        db,
        getConfig: getConfigFn,
        isWindowOpen: isWindowOpenFn,
        gradeAdmission,
        notifyGradingSlotsAvailable,
        validateReloadedSession,
        labSessionService,
        dispatchGradingTask,
        cleanupTempFile,
        lastStreamGradeAt,
        generateRequestId,
        shuttingDown: () => isShuttingDown,
    });

    function start(port = parseInt(process.env.PORT, 10) || 10000) {
        return new Promise((resolve, reject) => {
            const onError = (err) => {
                if (err.code === 'EADDRINUSE') {
                    console.error(`FATAL: Port ${port} is already in use.`);
                    console.error('Another CSSS instance is probably still running with old routes.');
                    console.error('Stop it, then run `npm start` again. On Windows:');
                    console.error(`  netstat -ano | findstr :${port}`);
                    console.error('  taskkill /PID <pid> /F');
                    process.exit(1);
                }
                reject(err);
            };

            server.once('error', onError);
            server.listen(port, () => {
                server.removeListener('error', onError);
                logInfo(`CSSS Server running on http://localhost:${port}`, { port });
                resolve({ port });
            });
        });
    }

    async function stop() {
        if (isShuttingDown) return;
        isShuttingDown = true;

        for (const handle of intervalHandles) {
            clearInterval(handle);
        }

        io.disconnectSockets(true);
        await Promise.race([
            new Promise((resolve) => io.close(() => resolve())),
            new Promise((resolve) => setTimeout(resolve, options.testMode ? 500 : SERVER_CLOSE_TIMEOUT_MS)),
        ]);

        if (options.testMode && typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
        }

        let serverClosed = false;
        await Promise.race([
            new Promise((resolve) => server.close(() => { serverClosed = true; resolve(); })),
            new Promise((resolve) => setTimeout(resolve, options.testMode ? 500 : SERVER_CLOSE_TIMEOUT_MS)),
        ]);
        if (!serverClosed && typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
        }

        if (!options.testMode) {
            const drainStart = Date.now();
            while (graderPool.getPendingCount() > 0) {
                if (Date.now() - drainStart > SHUTDOWN_DRAIN_TIMEOUT_MS) break;
                await new Promise((r) => setTimeout(r, 200));
            }
        }

        graderPool.shutdown();
        db.releaseAllServerLocks();
        if (typeof db.closeDatabase === 'function') {
            db.closeDatabase();
        }

        if (options.testMode && typeof server.unref === 'function') {
            server.unref();
        }
    }

    return {
        app,
        server,
        io,
        db,
        graderPool,
        gradeAdmission,
        start,
        stop,
    };
}

module.exports = { createApp };
