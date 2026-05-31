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
const { getConfig, isWindowOpen } = require('./config');
const { GraderWorkerPool } = require('./workerPool');
const authRoutes = require('./routes/auth');
const quizRoutes = require('./routes/quiz');
const adminRoutes = require('./routes/admin');
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) {
   app.set('trust proxy', parseInt(process.env.TRUST_PROXY) || 1);
}

const server = http.createServer(app);

const cfgInitial = getConfig();
let globalMaxUploadMB = 75;
(cfgInitial.labs || []).forEach(l => {
   if (l.max_upload_mb && l.max_upload_mb > globalMaxUploadMB) {
       globalMaxUploadMB = l.max_upload_mb;
   }
});

const io = new Server(server, { maxHttpBufferSize: globalMaxUploadMB * 1024 * 1024 });

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
       "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
       "font-src 'self' https://fonts.gstatic.com data:; " +
       "img-src 'self' data:; " +
       "connect-src 'self' ws: wss:; " +
       "frame-ancestors 'none';"
   );
   next();
});

app.use('/api', (req, res, next) => {
   res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
   res.setHeader('Pragma', 'no-cache');
   res.setHeader('Expires', '0');
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

app.use((req, res, next) => {
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
const sendPage = (filename) => (_req, res) => res.sendFile(path.join(publicDir, filename));

app.get('/', sendPage('index.html'));
app.get('/challenges', sendPage('challenges.html'));
app.get('/history', sendPage('history.html'));
app.get('/leaderboard', sendPage('leaderboard.html'));
app.get('/lab', sendPage('lab.html'));
app.get('/quiz', sendPage('quiz.html'));
app.get('/admin', (req, res) => {
   if (!req.session?.userId) {
       return res.redirect('/');
   }
   const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.session.userId);
   if (!user || user.is_admin !== 1) {
       return res.redirect('/challenges');
   }
   res.sendFile(path.join(publicDir, 'admin.html'));
});

// Case-insensitive legacy .html URLs → clean routes (avoids static bypass on case-sensitive routers).
const LEGACY_HTML_REDIRECTS = {
   'index.html': '/',
   'challenges.html': '/challenges',
   'history.html': '/history',
   'leaderboard.html': '/leaderboard',
   'lab.html': '/lab',
   'quiz.html': '/quiz',
   'admin.html': '/admin',
};
const LEGACY_HTML_NAMES = new Set(Object.keys(LEGACY_HTML_REDIRECTS));

app.get(/^\/([^/]+\.html)$/i, (req, res, next) => {
   const target = LEGACY_HTML_REDIRECTS[String(req.params[0]).toLowerCase()];
   if (!target) return next();
   const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
   res.redirect(301, target + search);
});

// Never serve app shell HTML via static (Admin.html etc. on case-insensitive disks).
app.use((req, res, next) => {
   if (req.method !== 'GET' && req.method !== 'HEAD') return next();
   const match = req.path.match(/^\/([^/]+\.html)$/i);
   if (match && LEGACY_HTML_NAMES.has(match[1].toLowerCase())) {
       return res.status(404).end();
   }
   next();
});

app.use(express.static(publicDir));

const MAX_WORKERS = parseInt(process.env.MAX_WORKERS, 10) || 4;
const MAX_QUEUE_DEPTH = parseInt(process.env.MAX_QUEUE_DEPTH, 10) || 50;
const WORKER_TIMEOUT_MS = 120000;
const graderPool = new GraderWorkerPool(MAX_WORKERS, WORKER_TIMEOUT_MS);

const cleanupTempFile = (filePath) => {
   if (filePath && fs.existsSync(filePath)) {
       try { fs.unlinkSync(filePath); } catch (e) {}
   }
};

function labConfigForWorker(lab) {
   return JSON.parse(JSON.stringify(lab));
}

function dispatchGradingTask(task) {
   const { socket, lockKey, socketUser, targetLab, inProgressId, maxXmlMb, tempFilePath, fileBuffer, transferList } = task;
   const retainXml = process.env.RETAIN_XML === 'true';

   let finished = false;
   const finishTask = () => {
       if (finished) return;
       finished = true;
       db.releaseLock(lockKey);
       cleanupTempFile(tempFilePath);
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

                   if (inProgressId) {
                       db.prepare("UPDATE submissions SET score = ?, max_score = ?, details = ?, status = 'completed' WHERE id = ?")
                           .run(grading.total, grading.max, JSON.stringify(grading.serverBreakdown), inProgressId);
                   } else {
                       db.prepare('INSERT INTO submissions (user_id, unique_id, lab_id, score, max_score, details, type, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                           .run(socketUser.id, socketUser.unique_id, targetLab.id, grading.total, grading.max, JSON.stringify(grading.serverBreakdown), 'lab', 'completed');
                   }

                   if (process.env.RETAIN_PKA === 'true' || retainXml) {
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
                       total: grading.total, max: grading.max, clientBreakdown: grading.clientBreakdown, show_score: grading.show_score
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
       db.prepare("DELETE FROM active_locks WHERE timestamp < datetime('now', '-5 minutes')").run();
       
       const cfg = getConfig();
       const labs = cfg.labs || [];
       const inProgress = db.prepare("SELECT * FROM submissions WHERE status = 'in_progress' AND type = 'lab'").all();

       inProgress.forEach(sub => {
           const labCfg = labs.find(l => l.id === sub.lab_id);
           if (labCfg) {
               let closeSession = false;
               let reason = "";

               if (labCfg.time_limit_minutes && labCfg.time_limit_minutes > 0) {
                   const startTime = new Date(sub.timestamp.replace(' ', 'T') + 'Z').getTime();
                   const elapsed = Math.floor((Date.now() - startTime) / 1000);
                   if (elapsed > (labCfg.time_limit_minutes * 60) + 2) {
                       closeSession = true;
                       reason = "Auto-closed: Time limit expired.";
                   }
               }

               if (!isWindowOpen(labCfg)) {
                   closeSession = true;
                   reason = "Auto-closed: Competition window ended.";
               }

               if (closeSession) {
                   db.prepare("UPDATE submissions SET status = 'completed', score = 0, max_score = 0, details = ? WHERE id = ?")
                       .run(JSON.stringify([{message: reason, device: "N/A", possible: 0, awarded: 0, passed: false}]), sub.id);
               }
           }
       });
   } catch (e) {
       console.error("Error in sweeping routines:", e.message);
   }
}, 60 * 1000);

// Initialize a global registry to track active socket connections by user ID
global.activeUserSockets = global.activeUserSockets || new Map();

io.on('connection', (socket) => {
   let socketUser = null;
   let isAuthenticated = false;
   let authInProgress = false;
   let authAttempts = 0;
   const MAX_AUTH_ATTEMPTS = 10;

   socket.on('authenticate', () => {
       if (authInProgress) return;
       // Issue 6: Rate-limit authenticate events to prevent DB query amplification
       if (authAttempts >= MAX_AUTH_ATTEMPTS) {
           return socket.emit('auth_fail');
       }
       authAttempts++;
       authInProgress = true;

       const sess = socket.request.session;
       if (sess && sess.userId && sess.uniqueId) {
           const user = db.prepare('SELECT * FROM users WHERE id = ?').get(sess.userId);
           if (user) {
               socketUser = user;
               isAuthenticated = true;
               authInProgress = false;

               // Track the socket for active session management
               if (!global.activeUserSockets.has(user.id)) {
                   global.activeUserSockets.set(user.id, new Set());
               }
               global.activeUserSockets.get(user.id).add(socket);

               socket.on('disconnect', () => {
                   const userSet = global.activeUserSockets.get(user.id);
                   if (userSet) {
                       userSet.delete(socket);
                       if (userSet.size === 0) {
                           global.activeUserSockets.delete(user.id);
                       }
                   }
               });

               socket.emit('auth_success', user.unique_id);
               return;
           }
       }
       authInProgress = false;
       socket.emit('auth_fail');
   });

   socket.on('upload_file', (packet) => {
       if (!isAuthenticated || !socketUser) return socket.emit('err', "Unauthorized");

       // Issue 3: Validate packet is a plain object before any field access
       if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
           return socket.emit('err', "Invalid upload packet.");
       }

       // Issue 5: Re-read session from store rather than using the connection-time snapshot,
       // so server-side invalidation (e.g. admin delete) is reflected immediately.
       socket.request.session.reload((reloadErr) => {
       if (reloadErr) {
           isAuthenticated = false;
           socketUser = null;
           return socket.emit('err', "Session expired. Please refresh and log in again.");
       }

       const sess = socket.request.session;
       if (!sess || !sess.userId || sess.userId !== socketUser.id) {
           isAuthenticated = false;
           socketUser = null;
           return socket.emit('err', "Session expired. Please refresh and log in again.");
       }

       const userRow = db.prepare('SELECT id, password_changed_at FROM users WHERE id = ?').get(sess.userId);
       if (!userRow) {
           isAuthenticated = false;
           socketUser = null;
           return socket.emit('err', "Session expired. Please refresh and log in again.");
       }
       if (userRow.password_changed_at && (!sess.authenticatedAt || sess.authenticatedAt < userRow.password_changed_at)) {
           isAuthenticated = false;
           socketUser = null;
           return socket.emit('err', "Session expired. Please refresh and log in again.");
       }

       const clientToken = packet._csrf;
       if (!clientToken || clientToken !== sess.csrfToken) {
           return socket.emit('err', "Invalid CSRF token. Please refresh the page.");
       }

       const fileData = packet.fileData;
       if (!fileData || (!Buffer.isBuffer(fileData) && typeof fileData !== 'string')) {
           return socket.emit('err', "Invalid file format.");
       }

       const cfg = getConfig();
       const labs = cfg.labs || [];
       // Issue 4: Ensure labId is a string to prevent object/array pass-through
       const rawLabId = typeof packet.labId === 'string' ? packet.labId : null;
       const labId = rawLabId || (labs.length > 0 ? labs[0].id : null);
       const userId = socketUser.id;

       if (!labId) return socket.emit('err', "No configuration loaded.");

       const targetLab = labs.find(l => l.id === labId);
       if (!targetLab) return socket.emit('err', "Invalid Lab ID.");

       if (!isWindowOpen(targetLab)) {
           return socket.emit('err', "Submissions are currently closed outside of the competition window.");
       }

       const labMaxMb = targetLab.max_upload_mb || 75;
       if (Buffer.byteLength(fileData) > labMaxMb * 1024 * 1024) {
           return socket.emit('err', `File exceeds the maximum allowed size for this lab.`);
       }

       const lockKey = `lab_${userId}_${labId}`;
       if (!db.acquireLock(lockKey)) {
           return socket.emit('err', "A submission is currently processing. Please wait.");
       }

       let tempFilePath; // Lifted outside `try` block to prevent ReferenceError (TDZ issue)
       try {
           if (graderPool.getPendingCount() >= MAX_QUEUE_DEPTH) {
               db.releaseLock(lockKey);
               return socket.emit('err', "Server is busy. Please try again in a moment.");
           }

           let inProgressId = null;
           const activeSession = db.prepare("SELECT id, timestamp FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'lab' ORDER BY id DESC LIMIT 1")
               .get(userId, labId);

           if (!activeSession) {
               db.releaseLock(lockKey);
               return socket.emit('err', "No active lab session. Please start the lab first.");
           }

           if (targetLab.time_limit_minutes && targetLab.time_limit_minutes > 0) {
               const startTime = new Date(activeSession.timestamp.replace(' ', 'T') + 'Z').getTime();
               const elapsed = Math.floor((Date.now() - startTime) / 1000);

               if (elapsed > (targetLab.time_limit_minutes * 60) + 2) {
                   db.prepare("UPDATE submissions SET status = 'completed', score = 0, max_score = 0, details = ? WHERE id = ?")
                       .run(JSON.stringify([{message: "Time expired on submission.", device: "N/A", possible: 0, awarded: 0, passed: false}]), activeSession.id);
                   db.releaseLock(lockKey);
                   return socket.emit('err', "Time limit expired. Your submission was rejected.");
               }
           }
           inProgressId = activeSession.id;

           const maxXmlMb = targetLab.max_xml_output_mb || 20;

           const retainPka = process.env.RETAIN_PKA === 'true';
           const fileBuffer = Buffer.from(fileData);

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
           };

           if (retainPka) {
               const tmpDir = os.tmpdir();
               tempFilePath = path.join(tmpDir, `csss_${crypto.randomBytes(16).toString('hex')}.tmp`);
               task.tempFilePath = tempFilePath;

               fs.writeFile(tempFilePath, fileBuffer, (writeErr) => {
                   if (writeErr) {
                       db.releaseLock(lockKey);
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
server.listen(PORT, () => console.log(`CSSS Server running on http://localhost:${PORT}`));