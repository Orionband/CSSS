const dotenv = require('dotenv');
dotenv.config();

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    console.error('FATAL: SESSION_SECRET is missing or too short (minimum 32 characters). Refusing to start.');
    console.error('Run `node quickstart.js` to generate a .env file with a secure SESSION_SECRET.');
    process.exit(1);
}

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const db = require('./database');
const { elapsedSecondsSince } = require('./submissionDuration');
const { getConfig, isWindowOpen } = require('./config');
const { resolveUploadMb, maxUploadMbFromLabs, getConfigNumber } = require('./limits');
const { GraderWorkerPool } = require('./workerPool');
const { GradeAdmissionQueue } = require('./gradeAdmissionQueue');
const authRoutes = require('./routes/auth');
const quizRoutes = require('./routes/quiz');
const adminRoutes = require('./routes/admin');
const {
    MAX_AUTH_ATTEMPTS_PER_SOCKET,
    getSocketClientIp,
    authAttemptsByIp,
    uploadAttemptsByUser,
    registerSocketConnection,
    canAddUserSocket,
} = require('./socketLimits');
const app = express();
app.disable('x-powered-by');
const trustProxy = process.env.TRUST_PROXY?.trim();
if (trustProxy) {
   const hops = Number(trustProxy);
   app.set('trust proxy', Number.isInteger(hops) && String(hops) === trustProxy ? hops : trustProxy);
}

const server = http.createServer(app);

const cfgInitial = getConfig();
const globalMaxUploadMB = maxUploadMbFromLabs(cfgInitial.labs);
const SOCKET_MAX_UPLOAD_MB = 60;
const socketMaxUploadMB = Math.min(
    globalMaxUploadMB,
    resolveUploadMb(process.env.DEFAULT_MAX_UPLOAD_MB, SOCKET_MAX_UPLOAD_MB),
    SOCKET_MAX_UPLOAD_MB // hard cap on Socket.IO packet size
);

const io = new Server(server, {
    maxHttpBufferSize: socketMaxUploadMB * 1024 * 1024,
});

app.use(express.json({ limit: '1mb' }));

// Security headers (applied before session so /health stays session-free)
app.use((req, res, next) => {
   res.setHeader('X-Content-Type-Options', 'nosniff');
   res.setHeader('X-Frame-Options', 'DENY');
   res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
   res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
   if (process.env.NODE_ENV === 'production') {
       res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
   }
   res.setHeader('Content-Security-Policy',
       "default-src 'self'; " +
       "script-src 'self'; " +
       "style-src 'self' https://fonts.googleapis.com; " +
       "font-src 'self' https://fonts.gstatic.com data:; " +
       "img-src 'self' data:; " +
       "connect-src 'self'; " +
       "frame-ancestors 'none';"
   );
   next();
});

app.use('/api', (req, res, next) => {
   res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
   next();
});

// Health / keep-alive: no session store writes (load balancers, client poll)
app.get('/health', (req, res) => {
   res.status(200).send('OK');
});

const sessionMiddleware = session({
   store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 900000 } }),
   secret: process.env.SESSION_SECRET,
   resave: false,
   saveUninitialized: false,
   cookie: {
       httpOnly: true,  
       secure: 'auto',
       sameSite: 'lax',
       maxAge: 24 * 60 * 60 * 1000
   }
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

// Session validation: account exists and password not reset since login (API only — not static assets).
app.use('/api', (req, res, next) => {
   if (req.session && req.session.userId) {
       const user = db.prepare('SELECT id, password_changed_at FROM users WHERE id = ?').get(req.session.userId);
       if (!user) {
           req.session.destroy(() => {
               res.clearCookie('connect.sid');
               return res.status(401).json({ error: "Session invalidated: Account no longer exists." });
           });
           return;
       }
       if (user.password_changed_at && (!req.session.authenticatedAt || req.session.authenticatedAt < user.password_changed_at)) {
           req.session.destroy(() => {
               res.clearCookie('connect.sid');
               return res.status(401).json({ error: "Session invalidated: Password was reset. Please log in again." });
           });
           return;
       }
   }
   next();
});

// CSRF validation for state-changing API requests only (tokens issued via GET /api/csrf-token)
app.use('/api', (req, res, next) => {
   if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

   const clientToken = req.headers['x-csrf-token'] || (req.body && req.body._csrf);

   if (!req.session || !req.session.csrfToken || clientToken !== req.session.csrfToken) {
       return res.status(403).json({ error: "Invalid or missing CSRF token." });
   }

   next();
});

app.use('/api', authRoutes);
app.use('/api/quiz', quizRoutes);
app.use('/api/admin', adminRoutes);

const publicDir = path.join(__dirname, '../public');
const sendPage = (filename) => (req, res) => {
    if (req.session?.userId) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
    res.sendFile(path.join(publicDir, filename));
};

app.get('/', sendPage('index.html'));
app.get('/challenges', sendPage('challenges.html'));
app.get('/history', sendPage('history.html'));
app.get('/leaderboard', sendPage('leaderboard.html'));
app.get('/leaderboard/user', sendPage('leaderboard-user.html'));
app.get('/lab', sendPage('lab.html'));
app.get('/quiz', sendPage('quiz.html'));
app.get('/admin', (req, res) => {
   if (!req.session?.userId) {
       return res.redirect('/');
   }
   const user = db.prepare('SELECT is_admin, password_changed_at FROM users WHERE id = ?').get(req.session.userId);
   if (!user) {
       req.session.destroy(() => { res.clearCookie('connect.sid'); });
       return res.redirect('/');
   }
   if (user.password_changed_at && (!req.session.authenticatedAt || req.session.authenticatedAt < user.password_changed_at)) {
       req.session.destroy(() => { res.clearCookie('connect.sid'); });
       return res.redirect('/');
   }
   if (user.is_admin !== 1) {
       return res.redirect('/challenges');
   }
   res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
   res.setHeader('Pragma', 'no-cache');
   res.setHeader('Expires', '0');
   res.sendFile(path.join(publicDir, 'admin.html'));
});

// Case-insensitive legacy .html URLs → clean routes (avoids static bypass on case-sensitive routers).
const LEGACY_HTML_REDIRECTS = {
   'index.html': '/',
   'challenges.html': '/challenges',
   'history.html': '/history',
   'leaderboard.html': '/leaderboard',
   'leaderboard-user.html': '/leaderboard/user',
   'lab.html': '/lab',
   'quiz.html': '/quiz',
   'admin.html': '/admin',
};

// GET/HEAD legacy .html URLs → clean routes (avoids static bypass on case-insensitive disks).
app.use((req, res, next) => {
   if (req.method !== 'GET' && req.method !== 'HEAD') return next();
   const match = req.path.match(/^\/([^/]+\.html)$/i);
   if (!match) return next();
   const target = LEGACY_HTML_REDIRECTS[match[1].toLowerCase()];
   if (!target) return next();
   const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
   res.redirect(301, target + search);
});

app.use(express.static(publicDir));

const MAX_WORKERS = parseInt(process.env.MAX_WORKERS, 10) || 4;
const MAX_QUEUE_DEPTH = parseInt(process.env.MAX_QUEUE_DEPTH, 10) || 50;
const WORKER_TIMEOUT_MS = 120000;
const graderPool = new GraderWorkerPool(MAX_WORKERS, WORKER_TIMEOUT_MS);
const GRADE_SLOT_TTL_MS = parseInt(process.env.GRADE_SLOT_TTL_MS, 10) || 60000;
const gradeAdmission = new GradeAdmissionQueue({
    maxWorkers: MAX_WORKERS,
    maxAdmissionDepth: MAX_QUEUE_DEPTH,
    slotTtlMs: GRADE_SLOT_TTL_MS,
    getGraderPendingCount: () => graderPool.getPendingCount(),
});

function notifyGradingSlotsAvailable() {
    gradeAdmission.tryGrantSlots();
}

function parseDeclaredFileSize(raw, maxMb) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null;
    const maxBytes = maxMb * 1024 * 1024;
    if (n > maxBytes) return null;
    return n;
}

function isLabSubmissionLockHeld(lockKey) {
    return Boolean(db.prepare('SELECT 1 FROM active_locks WHERE lock_key = ?').get(lockKey));
}

const cleanupTempFile = (filePath) => {
   if (filePath && fs.existsSync(filePath)) {
       try { fs.unlinkSync(filePath); } catch (e) {}
   }
};

function labConfigForWorker(lab) {
   return JSON.parse(JSON.stringify(lab));
}

const STREAM_MIN_INTERVAL_MS = 115 * 1000;
const lastStreamGradeAt = new Map();

function streamGradeKey(userId, labId) {
   return `${userId}:${labId}`;
}

function parsePacketBool(value) {
   return value === true;
}

function dispatchGradingTask(task) {
   const {
       socket, lockKey, socketUser, targetLab, inProgressId, maxXmlMb,
       tempFilePath, fileBuffer, transferList, streaming, finalSubmit, sessionTimestamp,
   } = task;
   const isStreamPoll = streaming && !finalSubmit;
   const retainXml = process.env.RETAIN_XML === 'true' && !isStreamPoll;

   let finished = false;
   const finishTask = () => {
       if (finished) return;
       finished = true;
       db.releaseLock(lockKey);
       cleanupTempFile(tempFilePath);
       notifyGradingSlotsAvailable();
   };

   const workerPayload = {
       labConfig: labConfigForWorker(targetLab),
       maxXmlMb,
       retainXml,
   };
   if (fileBuffer) workerPayload.fileBuffer = fileBuffer;
   if (tempFilePath) workerPayload.tempFilePath = tempFilePath;

   graderPool.enqueue(
       workerPayload,
       transferList,
       (msg) => {
           if (msg.type === 'progress') socket.emit('progress', msg);
           else if (msg.type === 'file_verified') socket.emit('file_verified');
           else if (msg.type === 'result') {
               if (finished) return;
               try {
                   const { grading } = msg;
                   const timestamp = Date.now();
                   const capturesDir = path.join(__dirname, '../captures');

                   const detailsJson = JSON.stringify(grading.serverBreakdown);
                   let scoreRecorded = true;

                   if (isStreamPoll) {
                       const durationSeconds = sessionTimestamp
                           ? elapsedSecondsSince(sessionTimestamp)
                           : null;
                       db.prepare(
                           "INSERT INTO submissions (user_id, unique_id, lab_id, score, max_score, details, type, status, duration_seconds, stream_poll) VALUES (?, ?, ?, ?, ?, ?, 'lab', 'completed', ?, 1)"
                       ).run(
                           socketUser.id,
                           socketUser.unique_id,
                           targetLab.id,
                           grading.total,
                           grading.max,
                           detailsJson,
                           durationSeconds
                       );
                       lastStreamGradeAt.set(streamGradeKey(socketUser.id, targetLab.id), Date.now());
                   } else if (inProgressId) {
                       scoreRecorded = db.recordLabGradeResult(
                           socketUser.id,
                           targetLab.id,
                           inProgressId,
                           grading.total,
                           grading.max,
                           detailsJson
                       );
                   } else {
                       db.prepare('INSERT INTO submissions (user_id, unique_id, lab_id, score, max_score, details, type, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                           .run(socketUser.id, socketUser.unique_id, targetLab.id, grading.total, grading.max, detailsJson, 'lab', 'completed');
                   }

                   if (!scoreRecorded) {
                       socket.emit('err', 'Lab session ended before grading finished. No score was recorded.');
                       return;
                   }

                   if ((process.env.RETAIN_PKA === 'true' && !isStreamPoll) || retainXml) {
                       if (!fs.existsSync(capturesDir)) fs.mkdirSync(capturesDir, { recursive: true });
                       const safeTitle = targetLab.title.replace(/[^a-z0-9]/gi, '_');
                       const baseName = `${safeTitle}_${socketUser.unique_id}_${timestamp}`;
                       if (process.env.RETAIN_PKA === 'true' && tempFilePath && fs.existsSync(tempFilePath)) {
                           fs.copyFileSync(tempFilePath, path.join(capturesDir, `${baseName}.pka`));
                           fs.copyFileSync(tempFilePath, path.join(capturesDir, `${baseName}.pkt`));
                       }
                       if (retainXml && msg.xml) {
                           fs.writeFileSync(path.join(capturesDir, `${baseName}.xml`), msg.xml);
                       }
                   }

                   const payload = {
                       total: grading.total,
                       max: grading.max,
                       clientBreakdown: grading.clientBreakdown,
                       show_score: grading.show_score,
                       streaming: isStreamPoll,
                       final: Boolean(finalSubmit),
                   };

                   if (!grading.show_score) { delete payload.total; delete payload.max; }

                   socket.emit('result', payload);
               } catch (e) {
                   socket.emit('err', "An internal processing error occurred.");
               } finally {
                   finishTask();
               }
           } else if (msg.type === 'error') {
               socket.emit('err', msg.msg);
               finishTask();
           }
       },
       (errMsg) => {
           socket.emit('err', errMsg);
           finishTask();
       }
   );
}

// Sweepers
setInterval(() => {
   try {
       db.clearStaleLocks();
       
       const cfg = getConfig();
       const labs = cfg.labs || [];
       const inProgress = db.prepare("SELECT * FROM submissions WHERE status = 'in_progress' AND type = 'lab'").all();

       inProgress.forEach(sub => {
           const labCfg = labs.find(l => l.id === sub.lab_id);
           if (!labCfg) return;

           let closeSession = false;
           let reason = "";
           const timeLimitMinutes = getConfigNumber(labCfg.time_limit_minutes, 0);

           if (timeLimitMinutes > 0) {
               const startTime = new Date(sub.timestamp.replace(' ', 'T') + 'Z').getTime();
               const elapsed = Math.floor((Date.now() - startTime) / 1000);
               if (elapsed > (timeLimitMinutes * 60) + 2) {
                   closeSession = true;
                   reason = "Auto-closed: Time limit expired.";
               }
           }

           if (!isWindowOpen(labCfg)) {
               closeSession = true;
               reason = "Auto-closed: Competition window ended.";
           }

           if (!closeSession) return;

           const lockKey = `lab_${sub.user_id}_${sub.lab_id}`;
           if (!db.acquireLock(lockKey)) {
               return;
           }

           try {
               const durationSeconds = elapsedSecondsSince(sub.timestamp);
               db.prepare("UPDATE submissions SET status = 'completed', score = 0, max_score = 0, details = ?, duration_seconds = ? WHERE id = ? AND status = 'in_progress'")
                   .run(JSON.stringify([{message: reason, device: "N/A", possible: 0, awarded: 0, passed: false}]), durationSeconds, sub.id);
           } finally {
               db.releaseLock(lockKey);
           }
       });
   } catch (e) {
       console.error("Error in sweeping routines:", e.message);
   }
}, 60 * 1000);

/** After session.reload; null if the socket should not stay authenticated. */
function validateReloadedSession(sess) {
    if (!sess?.userId || !sess.uniqueId) return null;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(sess.userId);
    if (!user) return null;
    if (user.password_changed_at && (!sess.authenticatedAt || sess.authenticatedAt < user.password_changed_at)) {
        return null;
    }
    return user;
}

function sweepStaleAuthenticatedSockets() {
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
                if (reloadErr || !validateReloadedSession(req.session)) {
                    socket.disconnect(true);
                }
            });
        }
    }
}

// Initialize a global registry to track active socket connections by user ID
global.activeUserSockets = global.activeUserSockets || new Map();

// CLI (tool.js) invalidates DB sessions in another process; reload + validate evicts stale sockets.
setInterval(() => {
    try {
        sweepStaleAuthenticatedSockets();
    } catch (e) {
        console.error('Error in socket session sweep:', e.message);
    }
}, 30 * 1000);

io.on('connection', (socket) => {
   if (!registerSocketConnection(socket)) {
       socket.emit('err', 'Too many connections from this address.');
       socket.disconnect(true);
       return;
   }

   let socketUser = null;
   let isAuthenticated = false;
   let authInProgress = false;
   let authAttempts = 0;
   const clientIp = getSocketClientIp(socket);
   let socketSessionTracked = false;

   socket.on('disconnect', () => {
       gradeAdmission.removeSocket(socket.id);
       notifyGradingSlotsAvailable();
   });

   socket.on('authenticate', () => {
       if (authInProgress) return;
       if (authAttempts >= MAX_AUTH_ATTEMPTS_PER_SOCKET) {
           return socket.emit('auth_fail');
       }
       if (!authAttemptsByIp(clientIp)) {
           return socket.emit('auth_fail');
       }
       authAttempts++;
       authInProgress = true;

       socket.request.session.reload((reloadErr) => {
           const failAuth = () => {
               authInProgress = false;
               isAuthenticated = false;
               socketUser = null;
               socket.emit('auth_fail');
           };

           if (reloadErr) return failAuth();

           const sess = socket.request.session;
           const user = validateReloadedSession(sess);
           if (!user) {
               return failAuth();
           }

           if (!canAddUserSocket(user.id)) {
               authInProgress = false;
               return socket.emit('auth_fail');
           }

           socketUser = user;
           isAuthenticated = true;
           authInProgress = false;

           if (!global.activeUserSockets.has(user.id)) {
               global.activeUserSockets.set(user.id, new Set());
           }
           global.activeUserSockets.get(user.id).add(socket);

           if (!socketSessionTracked) {
               socketSessionTracked = true;
               const trackedUserId = user.id;
               socket.on('disconnect', () => {
                   const userSet = global.activeUserSockets.get(trackedUserId);
                   if (userSet) {
                       userSet.delete(socket);
                       if (userSet.size === 0) {
                           global.activeUserSockets.delete(trackedUserId);
                       }
                   }
               });
           }

           socket.emit('auth_success', user.unique_id);
       });
   });

   socket.on('cancel_grade_slot', (packet) => {
       if (!isAuthenticated || !socketUser) return;

       if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return;

       const rawLabId = typeof packet.labId === 'string' ? packet.labId.trim() : '';
       if (!rawLabId) return;

       socket.request.session.reload((reloadErr) => {
           if (reloadErr) return;
           const sess = socket.request.session;
           if (!sess?.userId || sess.userId !== socketUser.id) return;
           if (!validateReloadedSession(sess)) return;
           if (!packet._csrf || packet._csrf !== sess.csrfToken) return;

           gradeAdmission.cancelWaiting(socket.id, socketUser.id, rawLabId);
       });
   });

   socket.on('request_grade_slot', (packet) => {
       if (!isAuthenticated || !socketUser) return socket.emit('err', "Unauthorized");

       if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
           return socket.emit('err', "Invalid request.");
       }

       const rawLabIdEarly = typeof packet.labId === 'string' ? packet.labId.trim() : '';
       if (!rawLabIdEarly) {
           return socket.emit('err', 'Invalid Lab ID.');
       }

       const cfgEarly = getConfig();
       const labsEarly = cfgEarly.labs || [];
       const targetLabEarly = labsEarly.find(l => l.id === rawLabIdEarly);
       if (!targetLabEarly) return socket.emit('err', "Invalid Lab ID.");

       const labMaxMbEarly = resolveUploadMb(targetLabEarly.max_upload_mb);
       const declaredSize = parseDeclaredFileSize(packet.fileSizeBytes, labMaxMbEarly);
       if (declaredSize === null) {
           return socket.emit('err', `File exceeds the maximum allowed size for this lab.`);
       }

       const userIdEarly = socketUser.id;
       if (!uploadAttemptsByUser(String(userIdEarly))) {
           return socket.emit('err', 'Too many submissions. You can upload at most 8 files per minute.');
       }

       socket.request.session.reload((reloadErr) => {
           if (reloadErr) {
               isAuthenticated = false;
               socketUser = null;
               return socket.emit('err', "Session expired. Please refresh and log in again.");
           }

           const sess = socket.request.session;
           if (!sess?.userId || sess.userId !== socketUser.id) {
               isAuthenticated = false;
               socketUser = null;
               return socket.emit('err', "Session expired. Please refresh and log in again.");
           }

           if (!validateReloadedSession(sess)) {
               isAuthenticated = false;
               socketUser = null;
               return socket.emit('err', "Session expired. Please refresh and log in again.");
           }

           if (!packet._csrf || packet._csrf !== sess.csrfToken) {
               return socket.emit('err', "Invalid CSRF token. Please refresh the page.");
           }

           const userId = userIdEarly;
           const labId = rawLabIdEarly;
           const targetLab = targetLabEarly;
           const lockKey = `lab_${userId}_${labId}`;

           if (!isWindowOpen(targetLab)) {
               return socket.emit('err', "Submissions are currently closed outside of the competition window.");
           }

           if (isLabSubmissionLockHeld(lockKey)) {
               return socket.emit('err', "A submission is currently processing. Please wait.");
           }

           const activeSession = db.prepare(
               "SELECT id, timestamp FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'lab' ORDER BY id DESC LIMIT 1"
           ).get(userId, labId);

           if (!activeSession) {
               return socket.emit('err', "No active lab session. Please start the lab first.");
           }

           const uploadTimeLimitMinutes = getConfigNumber(targetLab.time_limit_minutes, 0);
           if (uploadTimeLimitMinutes > 0) {
               const startTime = new Date(activeSession.timestamp.replace(' ', 'T') + 'Z').getTime();
               const elapsed = Math.floor((Date.now() - startTime) / 1000);
               if (elapsed > (uploadTimeLimitMinutes * 60) + 2) {
                   return socket.emit('err', "Time limit expired. Your submission was rejected.");
               }
           }

           const streaming = parsePacketBool(packet.streaming);
           const finalSubmit = parsePacketBool(packet.final);

           if (streaming && targetLab.live_streaming !== true) {
               return socket.emit('err', 'Live streaming is not enabled for this lab.');
           }

           if (streaming && !finalSubmit) {
               const streamKey = streamGradeKey(userId, labId);
               const lastAt = lastStreamGradeAt.get(streamKey);
               if (lastAt && Date.now() - lastAt < STREAM_MIN_INTERVAL_MS) {
                   const waitSec = Math.ceil((STREAM_MIN_INTERVAL_MS - (Date.now() - lastAt)) / 1000);
                   return socket.emit('err', `Please wait ${waitSec}s before the next stream grade.`);
               }
           }

           const result = gradeAdmission.enqueue({
               socket,
               userId,
               labId,
               fileSizeBytes: declaredSize,
           });

           if (!result.ok) {
               return socket.emit('err', result.error);
           }

           socket.emit('grade_slot_waiting', { position: result.position });
       });
   });

   socket.on('upload_file', (packet) => {
       if (!isAuthenticated || !socketUser) return socket.emit('err', "Unauthorized");

       // Issue 3: Validate packet is a plain object before any field access
       if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
           return socket.emit('err', "Invalid upload packet.");
       }

       if (typeof packet.slotToken !== 'string' || !packet.slotToken) {
           return socket.emit('err', "Missing grading slot. Please submit again.");
       }

       const fileDataEarly = packet.fileData;
       if (!fileDataEarly || (!Buffer.isBuffer(fileDataEarly) && typeof fileDataEarly !== 'string')) {
           return socket.emit('err', "Invalid file format.");
       }
       const cfgEarly = getConfig();
       const labsEarly = cfgEarly.labs || [];
       const rawLabIdEarly = typeof packet.labId === 'string' ? packet.labId.trim() : '';
       if (!rawLabIdEarly) {
           return socket.emit('err', 'Invalid Lab ID.');
       }
       const targetLabEarly = labsEarly.find(l => l.id === rawLabIdEarly);
       if (!targetLabEarly) return socket.emit('err', "Invalid Lab ID.");
       const labMaxMbEarly = resolveUploadMb(targetLabEarly.max_upload_mb);
       if (Buffer.byteLength(fileDataEarly) > labMaxMbEarly * 1024 * 1024) {
           return socket.emit('err', `File exceeds the maximum allowed size for this lab.`);
       }
       const userIdEarly = socketUser.id;

       // Issue 5: Re-read session from store rather than using the connection-time snapshot,
       // so server-side invalidation (e.g. admin delete) is reflected immediately.
       socket.request.session.reload((reloadErr) => {
       if (reloadErr) {
           isAuthenticated = false;
           socketUser = null;
           return socket.emit('err', "Session expired. Please refresh and log in again.");
       }

       const sess = socket.request.session;
       if (!sess?.userId || sess.userId !== socketUser.id) {
           isAuthenticated = false;
           socketUser = null;
           return socket.emit('err', "Session expired. Please refresh and log in again.");
       }

       if (!validateReloadedSession(sess)) {
           isAuthenticated = false;
           socketUser = null;
           return socket.emit('err', "Session expired. Please refresh and log in again.");
       }

       const clientToken = packet._csrf;
       if (!clientToken || clientToken !== sess.csrfToken) {
           return socket.emit('err', "Invalid CSRF token. Please refresh the page.");
       }

       const fileData = fileDataEarly;
       const labId = rawLabIdEarly;
       const userId = userIdEarly;
       const targetLab = targetLabEarly;

       if (!isWindowOpen(targetLab)) {
           return socket.emit('err', "Submissions are currently closed outside of the competition window.");
       }

       const lockKey = `lab_${userId}_${labId}`;
       if (!db.acquireLock(lockKey)) {
           return socket.emit('err', "A submission is currently processing. Please wait.");
       }

       const actualFileSize = Buffer.byteLength(fileDataEarly);
       const slotResult = gradeAdmission.consumeSlot(packet.slotToken, {
           socketId: socket.id,
           userId,
           labId,
           fileSizeBytes: actualFileSize,
       });
       if (!slotResult.ok) {
           db.releaseLock(lockKey);
           notifyGradingSlotsAvailable();
           return socket.emit('err', slotResult.error);
       }

       let tempFilePath; // Lifted outside `try` block to prevent ReferenceError (TDZ issue)
       try {
           let inProgressId = null;
           const activeSession = db.prepare("SELECT id, timestamp FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'lab' ORDER BY id DESC LIMIT 1")
               .get(userId, labId);

           if (!activeSession) {
               db.releaseLock(lockKey);
               notifyGradingSlotsAvailable();
               return socket.emit('err', "No active lab session. Please start the lab first.");
           }

           const uploadTimeLimitMinutes = getConfigNumber(targetLab.time_limit_minutes, 0);
           if (uploadTimeLimitMinutes > 0) {
               const startTime = new Date(activeSession.timestamp.replace(' ', 'T') + 'Z').getTime();
               const elapsed = Math.floor((Date.now() - startTime) / 1000);

               if (elapsed > (uploadTimeLimitMinutes * 60) + 2) {
                   db.prepare("UPDATE submissions SET status = 'completed', score = 0, max_score = 0, details = ?, duration_seconds = ? WHERE id = ?")
                       .run(JSON.stringify([{message: "Time expired on submission.", device: "N/A", possible: 0, awarded: 0, passed: false}]), elapsed, activeSession.id);
                   db.releaseLock(lockKey);
                   notifyGradingSlotsAvailable();
                   return socket.emit('err', "Time limit expired. Your submission was rejected.");
               }
           }
           inProgressId = activeSession.id;
           const streaming = parsePacketBool(packet.streaming);
           const finalSubmit = parsePacketBool(packet.final);
           const isStreamPoll = streaming && !finalSubmit;

           if (streaming && targetLab.live_streaming !== true) {
               db.releaseLock(lockKey);
               notifyGradingSlotsAvailable();
               return socket.emit('err', 'Live streaming is not enabled for this lab.');
           }

           const uploadDurationSeconds = elapsedSecondsSince(activeSession.timestamp);
           if (!isStreamPoll) {
               db.prepare("UPDATE submissions SET duration_seconds = ? WHERE id = ? AND status = 'in_progress'")
                   .run(uploadDurationSeconds, inProgressId);
           }

           const maxXmlMb = targetLab.max_xml_output_mb || 20;

           const retainPka = process.env.RETAIN_PKA === 'true' && !isStreamPoll;
           const fileBuffer = Buffer.isBuffer(fileData) ? fileData : Buffer.from(fileData);

           const task = {
               socket,
               lockKey,
               socketUser,
               targetLab,
               inProgressId,
               maxXmlMb,
               tempFilePath: null,
               fileBuffer: null,
               transferList: [],
               streaming,
               finalSubmit,
               sessionTimestamp: activeSession.timestamp,
           };

           if (retainPka) {
               const tmpDir = os.tmpdir();
               tempFilePath = path.join(tmpDir, `csss_${crypto.randomBytes(16).toString('hex')}.tmp`);
               task.tempFilePath = tempFilePath;

               fs.writeFile(tempFilePath, fileBuffer, (writeErr) => {
                   if (writeErr) {
                       db.releaseLock(lockKey);
                       notifyGradingSlotsAvailable();
                       return socket.emit('err', "An internal error occurred while saving the file.");
                   }
                   dispatchGradingTask(task);
               });
           } else {
               task.fileBuffer = fileBuffer;
               task.transferList = [fileBuffer.buffer];
               dispatchGradingTask(task);
           }

       } catch (err) {
           db.releaseLock(lockKey);
           cleanupTempFile(tempFilePath);
           notifyGradingSlotsAvailable();
           socket.emit('err', "An internal error occurred.");
       }
       }); // end session.reload
   });
});

setInterval(() => {
   const capturesDir = path.join(__dirname, '../captures');
   if (fs.existsSync(capturesDir)) {
       const now = Date.now();
       fs.readdir(capturesDir, (err, files) => {
           if (err) return;
           files.forEach(file => {
               const filePath = path.join(capturesDir, file);
               fs.stat(filePath, (err, stats) => {
                   if (err) return;
                   if (now - stats.mtimeMs > 30 * 24 * 60 * 60 * 1000) fs.unlink(filePath, () => {});
               });
           });
       });
   }
}, 24 * 60 * 60 * 1000);

const PORT = parseInt(process.env.PORT) || 10000;
server.on('error', (err) => {
   if (err.code === 'EADDRINUSE') {
       console.error(`FATAL: Port ${PORT} is already in use.`);
       console.error('Another CSSS instance is probably still running with old routes.');
       console.error('Stop it, then run `npm start` again. On Windows:');
       console.error(`  netstat -ano | findstr :${PORT}`);
       console.error('  taskkill /PID <pid> /F');
       process.exit(1);
   }
   throw err;
});
server.listen(PORT, () => console.log(`CSSS Server running on http://localhost:${PORT}`));